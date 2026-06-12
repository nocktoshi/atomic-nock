/**
 * Atomic Nock swap API (Cloudflare Worker).
 *
 * Security model
 * --------------
 *  - Reads are open (swap metadata is non-secret; the seller preimage is NEVER
 *    stored here — it stays client-side in IndexedDB).
 *  - Writes require an Iris-signed session (see session.ts + verify.ts). There is
 *    no shared write token in the browser anymore. The Worker owns the swap state
 *    machine and rejects any tampering (see swaps.ts).
 *
 * Endpoints
 *   GET  /auth/challenge?pkh=<pkh>      -> { challenge, challengeMac }
 *   POST /auth/login                    -> { token }
 *   POST /swap                          -> create (seller session)
 *   POST /swap/:id/claim                -> buyer commits to an open swap
 *   POST /swap/:id/cancel               -> seller cancels an unclaimed open swap
 *   POST /swap/:id/advance              -> party writes their progress fields
 *   GET  /swap/:id                      -> swap record
 *   GET  /feed?limit=                   -> { swaps, bids, ts } (cached marketplace)
 *   POST /bid                           -> buy order: pay USDC/wNOCK for native NOCK
 *   POST /bid/:id/fill                  -> NOCK holder fills a bid (creates the swap)
 *   POST /bid/:id/cancel                -> creator cancels their open bid
 *   GET  /list?prefix=&cursor=&limit=   -> { keys, cursor?, complete }
 *   GET  /profile                       -> the signed-in user's profile
 *   PUT  /profile                       -> update prefs/settings
 *   POST /profile/telegram/link-code    -> { code, bot, url } (t.me deep link)
 *   POST /profile/telegram/unlink       -> drop the telegram binding
 *   POST /profile/push-subscribe        -> register a browser push subscription
 *   POST /profile/push-unsubscribe      -> drop one subscription by endpoint
 *   POST /profile/email                 -> start email verification (sends a code)
 *   POST /profile/email/verify          -> confirm the 6-digit code
 *   POST /profile/email/remove          -> drop the email binding
 *   POST /tg/webhook                    -> Telegram bot updates (secret header)
 *   GET  /solver/state/swaps            -> solver tracked swaps (solver session)
 *   PUT  /solver/state/swaps/:hEvm      -> upsert tracked swap
 *   PATCH /solver/state/swaps/:hEvm     -> patch phase / metadata
 *   PUT  /solver/state/swaps/:hEvm/secret -> persist seller preimage
 *   GET/POST /solver/state/pnl          -> P&L ledger
 *   GET  /solver/state/pnl/summary      -> P&L totals
 *   GET  /solver/status                 -> { online } (heartbeat, not stale quote)
 *   POST /solver/rfq                    -> create sized quote request
 *   GET  /solver/rfq/:id                -> poll RFQ result
 *   GET  /solver/rfq/pending            -> pending RFQs (solver session)
 *   POST /solver/rfq/:id/respond          -> price an RFQ (solver session)
 *   POST /solver/heartbeat              -> solver liveness (solver session)
 */
import {
  createSwap,
  claimSwap,
  advanceSwap,
  cancelSwap,
  loadSwap,
  listMySwapIds,
  SwapError,
  type Env,
} from "./swaps.js";
import { createBid, cancelBid, fillBid, lookupBid } from "./bids.js";
import { getMarketFeed } from "./feed.js";
import { oneClickQuote, oneClickGet, oneClickPost } from "./oneclick.js";
import {
  createRfq,
  getRfq,
  isSolverOnline,
  listPendingRfqs,
  respondRfq,
  touchHeartbeat,
} from "./solver-rfq.js";
import { allowedSolver } from "./solver-auth.js";
import {
  appendPnl,
  listPnl,
  listTrackedSwaps,
  loadTrackedSwap,
  patchTrackedSwap,
  pnlSummary,
  putSwapSecret,
  upsertTrackedSwap,
} from "./solver-store.js";
import type { PnlEntry, TrackedSwap, TrackedSwapPatch } from "../../src/solver-state.js";
import {
  makeChallenge,
  validateChallenge,
  issueToken,
  verifyToken,
  bearer,
} from "./session.js";
import { enforceRate } from "./ratelimit.js";
import {
  loadProfile,
  updateProfile,
  mintTelegramLinkCode,
  redeemTelegramLinkCode,
  unlinkTelegram,
  saveProfile,
  addPushSubscription,
  removePushSubscription,
  requestEmailVerification,
  confirmEmailVerification,
  removeEmail,
} from "./profile.js";
import { swapEvents, dispatch, sendTelegram, sendEmail } from "./notify.js";
import { verifyNockSignature } from "./verify.js";
import type {
  CreateBody,
  ClaimBody,
  AdvanceBody,
  LoginBody,
} from "./contract.js";

// Durable Object class must be exported from the worker entry module.
export { Market } from "./market-do.js";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof SwapError) {
    return json(
      { error: e.message },
      e.status,
      e.status === 429 ? { "retry-after": "60" } : {}
    );
  }
  console.error("worker error:", e);
  return json({ error: "internal error" }, 500);
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Resolve the signed-in pkh from the bearer token, or throw 401. */
async function requireSession(req: Request, env: Env): Promise<string> {
  if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
  const pkh = await verifyToken(bearer(req), env.SESSION_SECRET);
  if (!pkh) throw new SwapError(401, "sign in required");
  return pkh;
}

/** Session + SOLVER_PKHS gate for solver-only persistence routes. */
async function requireSolverSession(req: Request, env: Env): Promise<string> {
  const pkh = await requireSession(req, env);
  if (!allowedSolver(env, pkh)) throw new SwapError(403, "not an authorized solver pkh");
  return pkh;
}

/**
 * Rate-limit a read. The authenticated solver gets its own per-pkh budget
 * (RL_SOLVER): its polling — heartbeat, pending RFQs, feed, every in-flight
 * swap each tick — would otherwise exhaust the anonymous per-IP bucket and
 * starve browser reads (locally both are 127.0.0.1, which stalled RFQs at
 * "pending" while listPendingRfqs 429'd). Anonymous reads keep RL_READ by IP.
 */
async function enforceReadRate(req: Request, env: Env): Promise<void> {
  const token = bearer(req);
  if (token && env.SESSION_SECRET) {
    const pkh = await verifyToken(token, env.SESSION_SECRET).catch(() => null);
    if (pkh && allowedSolver(env, pkh)) {
      await enforceRate(env.RL_SOLVER ?? env.RL_READ, `solver:${pkh}`);
      return;
    }
  }
  await enforceRate(env.RL_READ, clientIp(req));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // --- auth ---------------------------------------------------------------
      if (path === "/auth/challenge" && req.method === "GET") {
        if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
        await enforceRate(env.RL_AUTH, clientIp(req));
        const pkh = url.searchParams.get("pkh");
        if (!pkh) throw new SwapError(400, "missing pkh");
        return json(await makeChallenge(pkh, env.SESSION_SECRET));
      }

      if (path === "/auth/login" && req.method === "POST") {
        if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
        await enforceRate(env.RL_AUTH, clientIp(req));
        const body = (await req.json()) as LoginBody;
        const pkh = await validateChallenge(
          body.challenge,
          body.challengeMac,
          env.SESSION_SECRET
        );
        if (!pkh) throw new SwapError(401, "invalid or expired challenge");
        const verified = verifyNockSignature(
          { message: body.challenge, pubkeyHex: body.pubkeyHex, signature: body.signature },
          pkh // bind: the pubkey must hash to the challenge's pkh
        );
        if (!verified) throw new SwapError(401, "signature verification failed");
        return json({ token: await issueToken(pkh, env.SESSION_SECRET) });
      }

      // --- writes (authed) ----------------------------------------------------
      if (path === "/swap" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as CreateBody;
        const rec = await createSwap(env, body.swap, pkh);
        return json({ ok: true, swap: rec });
      }

      const claimMatch = path.match(/^\/swap\/([^/]+)\/claim$/);
      if (claimMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as ClaimBody;
        const hEvm = decodeURIComponent(claimMatch[1]);
        const prev = await loadSwap(env, hEvm); // snapshot for transition diff
        const rec = await claimSwap(env, hEvm, body.buyerEth, pkh);
        ctx.waitUntil(dispatch(env, rec, swapEvents(prev, rec)));
        return json({ ok: true, swap: rec });
      }

      const cancelMatch = path.match(/^\/swap\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        await cancelSwap(env, decodeURIComponent(cancelMatch[1]), pkh);
        return json({ ok: true });
      }

      if (path === "/bid" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { bid?: Record<string, unknown> };
        const rec = await createBid(env, body.bid ?? {}, pkh);
        return json({ ok: true, bid: rec });
      }

      const bidFillMatch = path.match(/^\/bid\/([^/]+)\/fill$/);
      if (bidFillMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { swap?: Record<string, unknown> };
        const { swap, bid } = await fillBid(
          env,
          decodeURIComponent(bidFillMatch[1]),
          body.swap ?? {},
          pkh
        );
        // The bid creator (now the swap's buyer) waits for the filler's NOCK lock.
        ctx.waitUntil(
          dispatch(env, swap, [
              {
                recipientPkh: bid.creatorPkh,
                title: "Buy order filled",
                body: "Someone is selling you NOCK — they lock NOCK first, then you'll be prompted to lock your side on Base.",
                url: "",
              },
          ])
        );
        return json({ ok: true, swap });
      }

      const bidCancelMatch = path.match(/^\/bid\/([^/]+)\/cancel$/);
      if (bidCancelMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        await cancelBid(env, decodeURIComponent(bidCancelMatch[1]), pkh);
        return json({ ok: true });
      }

      const advanceMatch = path.match(/^\/swap\/([^/]+)\/advance$/);
      if (advanceMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as AdvanceBody;
        const hEvm = decodeURIComponent(advanceMatch[1]);
        const prev = await loadSwap(env, hEvm); // snapshot for transition diff
        const rec = await advanceSwap(env, hEvm, body.fields, pkh, body.expectedVersion);
        // Push Notifications
        ctx.waitUntil(dispatch(env, rec, swapEvents(prev, rec)));
        return json({ ok: true, swap: rec });
      }

      // --- profile + notifications (authed) -------------------------------------
      if (path === "/profile" && req.method === "GET") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_READ, clientIp(req));
        return json(await loadProfile(env, pkh));
      }

      if (path === "/profile" && req.method === "PUT") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { prefs?: unknown; settings?: unknown };
        return json(await updateProfile(env, pkh, body));
      }

      if (path === "/profile/telegram/link-code" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        if (!env.TELEGRAM_BOT_NAME) {
          throw new SwapError(503, "telegram notifications are not configured yet");
        }
        const code = await mintTelegramLinkCode(env, pkh);
        return json({
          code,
          bot: env.TELEGRAM_BOT_NAME,
          url: `https://t.me/${env.TELEGRAM_BOT_NAME}?start=${code}`,
        });
      }

      if (path === "/profile/telegram/unlink" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        return json(await unlinkTelegram(env, pkh));
      }

      if (path === "/profile/push-subscribe" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { subscription?: unknown };
        return json(await addPushSubscription(env, pkh, body.subscription));
      }

      if (path === "/profile/push-unsubscribe" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { endpoint?: string };
        return json(await removePushSubscription(env, pkh, body.endpoint ?? ""));
      }

      if (path === "/profile/email" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        if (!env.RESEND_API_KEY) {
          throw new SwapError(503, "email notifications are not configured yet");
        }
        const body = (await req.json()) as { address?: string };
        const { address, code } = await requestEmailVerification(env, pkh, body.address ?? "");
        await sendEmail(
          env,
          address,
          "Atomic Nock — verify your email",
          `Your verification code is: ${code}\n\nIt expires in 15 minutes. ` +
            "If you didn't request this, ignore this message."
        );
        return json({ ok: true, address });
      }

      if (path === "/profile/email/verify" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as { code?: string };
        return json(await confirmEmailVerification(env, pkh, body.code ?? ""));
      }

      if (path === "/profile/email/remove" && req.method === "POST") {
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        return json(await removeEmail(env, pkh));
      }

      // --- telegram webhook (called by Telegram's servers, not browsers) -------
      if (path === "/tg/webhook" && req.method === "POST") {
        // Authenticated via the secret header registered with setWebhook.
        if (
          !env.TELEGRAM_WEBHOOK_SECRET ||
          req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET
        ) {
          return json({ error: "forbidden" }, 403);
        }
        const update = (await req.json()) as {
          message?: {
            chat?: { id?: number };
            from?: { username?: string };
            text?: string;
          };
        };
        const chatId = update.message?.chat?.id;
        const m = (update.message?.text ?? "").match(/^\/start[ =]([0-9a-f]{32})\s*$/);
        if (chatId != null && m) {
          const pkh = await redeemTelegramLinkCode(env, m[1]);
          if (pkh) {
            const profile = await loadProfile(env, pkh);
            profile.telegram = {
              chatId,
              username: update.message?.from?.username,
              linkedAt: Math.floor(Date.now() / 1000),
            };
            profile.prefs = { ...profile.prefs, telegram: true };
            await saveProfile(env, pkh, profile);
            ctx.waitUntil(
              sendTelegram(
                env,
                chatId,
                "✅ Linked! You'll get a message here on every step of your Atomic Nock swaps."
              )
            );
          } else {
            ctx.waitUntil(
              sendTelegram(
                env,
                chatId,
                "That link code is invalid or expired — open Settings on atomicnock.com and try again."
              )
            );
          }
        }
        // Always 200 so Telegram doesn't endlessly retry malformed updates.
        return json({ ok: true });
      }

      // --- 1Click proxy (JWT + appFees injected server-side) ------------------
      // The browser hits these so the distribution-channel JWT (fee-free) and
      // our appFees never live in the frontend bundle.
      if (path === "/oneclick/quote" && req.method === "POST") {
        await enforceRate(env.RL_READ, clientIp(req));
        const body = (await req.json()) as Record<string, unknown>;
        return oneClickQuote(env, body);
      }
      if (path.startsWith("/oneclick/") && req.method === "GET") {
        await enforceRate(env.RL_READ, clientIp(req));
        const sub = path.slice("/oneclick/".length);
        return oneClickGet(env, sub, url.search);
      }
      if (path.startsWith("/oneclick/") && req.method === "POST") {
        await enforceRate(env.RL_READ, clientIp(req));
        const sub = path.slice("/oneclick/".length);
        return oneClickPost(env, sub, await req.json().catch(() => ({})));
      }

      // --- marketplace feed (cached) ------------------------------------------
      if (path === "/feed" && req.method === "GET") {
        await enforceReadRate(req, env);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const feed = await getMarketFeed(env, limit);
        return json(feed);
      }

      // --- solver RFQ (UI requests sized quotes; solver prices on its host) ----
      if (path === "/solver/status" && req.method === "GET") {
        await enforceRate(env.RL_READ, clientIp(req));
        return json({ online: await isSolverOnline(env) });
      }
      if (path === "/solver/rfq" && req.method === "POST") {
        await enforceRate(env.RL_READ, clientIp(req));
        const body = (await req.json()) as { side?: unknown; amountIn?: unknown };
        return json(await createRfq(env, body));
      }
      if (path === "/solver/rfq/pending" && req.method === "GET") {
        await requireSolverSession(req, env);
        await enforceReadRate(req, env);
        const rfqs = await listPendingRfqs(env);
        return json({ rfqs });
      }
      const rfqRespondMatch = path.match(/^\/solver\/rfq\/([^/]+)\/respond$/);
      if (rfqRespondMatch && req.method === "POST") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const id = decodeURIComponent(rfqRespondMatch[1]);
        const body = (await req.json()) as {
          status?: "ready" | "rejected";
          amountOut?: string;
          pricePerNock?: number;
          maxAmountIn?: string;
          reason?: string;
        };
        if (body.status !== "ready" && body.status !== "rejected") {
          throw new SwapError(400, "status must be ready or rejected");
        }
        return json(await respondRfq(env, id, pkh, { ...body, status: body.status }));
      }
      const rfqGetMatch = path.match(/^\/solver\/rfq\/([^/]+)$/);
      if (rfqGetMatch && req.method === "GET") {
        await enforceRate(env.RL_READ, clientIp(req));
        const id = decodeURIComponent(rfqGetMatch[1]);
        const rfq = await getRfq(env, id);
        if (!rfq) return json({ error: "not found" }, 404);
        return json(rfq);
      }
      if (path === "/solver/heartbeat" && req.method === "POST") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        await touchHeartbeat(env, pkh);
        return json({ ok: true });
      }

      // --- solver state persistence (RAM cache on bot; KV is durable store) ----
      if (path === "/solver/state/swaps" && req.method === "GET") {
        const pkh = await requireSolverSession(req, env);
        await enforceReadRate(req, env);
        return json({ swaps: await listTrackedSwaps(env, pkh) });
      }

      const solverSecretMatch = path.match(/^\/solver\/state\/swaps\/([^/]+)\/secret$/);
      if (solverSecretMatch && req.method === "PUT") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const hEvm = decodeURIComponent(solverSecretMatch[1]);
        const body = (await req.json()) as { secretHex?: string };
        if (!body.secretHex) throw new SwapError(400, "missing secretHex");
        const swap = await putSwapSecret(env, pkh, hEvm, body.secretHex);
        return json({ ok: true, swap });
      }

      const solverSwapMatch = path.match(/^\/solver\/state\/swaps\/([^/]+)$/);
      if (solverSwapMatch && req.method === "GET") {
        const pkh = await requireSolverSession(req, env);
        await enforceReadRate(req, env);
        const hEvm = decodeURIComponent(solverSwapMatch[1]);
        const swap = await loadTrackedSwap(env, pkh, hEvm);
        if (!swap) return json({ error: "not found" }, 404);
        return json(swap);
      }
      if (solverSwapMatch && req.method === "PUT") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const hEvm = decodeURIComponent(solverSwapMatch[1]);
        const body = (await req.json()) as TrackedSwap;
        if (!body.hEvm) body.hEvm = hEvm;
        if (body.hEvm.toLowerCase() !== hEvm.toLowerCase()) throw new SwapError(400, "hEvm mismatch");
        const swap = await upsertTrackedSwap(env, pkh, body);
        return json({ ok: true, swap });
      }
      if (solverSwapMatch && req.method === "PATCH") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const hEvm = decodeURIComponent(solverSwapMatch[1]);
        const body = (await req.json()) as TrackedSwapPatch;
        const swap = await patchTrackedSwap(env, pkh, hEvm, body);
        return json({ ok: true, swap });
      }

      if (path === "/solver/state/pnl" && req.method === "GET") {
        const pkh = await requireSolverSession(req, env);
        await enforceReadRate(req, env);
        return json({ pnl: await listPnl(env, pkh) });
      }
      if (path === "/solver/state/pnl" && req.method === "POST") {
        const pkh = await requireSolverSession(req, env);
        await enforceRate(env.RL_WRITE, pkh);
        const body = (await req.json()) as PnlEntry;
        const entry = await appendPnl(env, pkh, body);
        return json({ ok: true, entry });
      }
      if (path === "/solver/state/pnl/summary" && req.method === "GET") {
        const pkh = await requireSolverSession(req, env);
        await enforceReadRate(req, env);
        return json(pnlSummary(await listPnl(env, pkh)));
      }

      const bidGetMatch = path.match(/^\/bid\/([^/]+)$/);
      if (bidGetMatch && req.method === "GET") {
        await enforceReadRate(req, env);
        // An open bid returns the record; a filled one returns { filledHEvm }
        // so the creator's bid page can follow it to the swap.
        const bid = await lookupBid(env, decodeURIComponent(bidGetMatch[1]));
        if (!bid) return json({ error: "not found" }, 404);
        return json(bid);
      }

      const getMatch = path.match(/^\/swap\/([^/]+)$/);
      if (getMatch && req.method === "GET") {
        await enforceReadRate(req, env);
        const rec = await loadSwap(env, decodeURIComponent(getMatch[1]));
        if (!rec) return json({ error: "not found" }, 404);
        return json(rec);
      }

      if (path === "/list" && req.method === "GET") {
        // Authenticated + scoped: you may only list your OWN swaps. Every
        // participant is indexed by their nock pkh, so `idx:nock:<your pkh>:`
        // covers every swap you're part of — and nothing else is listable.
        const pkh = await requireSession(req, env);
        await enforceReadRate(req, env);
        const prefix = url.searchParams.get("prefix") ?? "";
        if (prefix !== `idx:nock:${pkh}:`) {
          return json({ error: "may only list your own swaps" }, 403);
        }
        // Served by the Market DO's participant index. Keys are synthesized in
        // the legacy idx:nock:<pkh>:<hEvm> shape so existing clients (solver
        // reconciliation, dashboard) parse them unchanged; the data is small
        // enough that pagination is always complete in one page.
        const ids = await listMySwapIds(env, pkh);
        return json({
          keys: ids.map((hEvm) => `idx:nock:${pkh}:${hEvm}`),
          cursor: undefined,
          complete: true,
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
