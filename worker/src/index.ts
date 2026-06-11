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
 *   GET  /open?cursor=&limit=           -> { swaps, cursor?, complete } (marketplace)
 *   POST /bid                           -> buy order: pay USDC/wNOCK for native NOCK
 *   GET  /bids                          -> open buy orders (marketplace)
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
 */
import {
  createSwap,
  claimSwap,
  advanceSwap,
  cancelSwap,
  listOpenSwaps,
  loadSwap,
  SwapError,
  type Env,
} from "./swaps.js";
import { createBid, listBids, cancelBid, fillBid, lookupBid } from "./bids.js";
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

      // --- reads (open) -------------------------------------------------------
      if (path === "/open" && req.method === "GET") {
        // Marketplace: open swaps anyone can browse and fill.
        await enforceRate(env.RL_READ, clientIp(req));
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json(await listOpenSwaps(env, cursor, limit));
      }

      if (path === "/bids" && req.method === "GET") {
        // Marketplace: open buy orders anyone can browse and fill.
        await enforceRate(env.RL_READ, clientIp(req));
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json({ bids: await listBids(env, limit) });
      }

      const bidGetMatch = path.match(/^\/bid\/([^/]+)$/);
      if (bidGetMatch && req.method === "GET") {
        await enforceRate(env.RL_READ, clientIp(req));
        // An open bid returns the record; a filled one returns { filledHEvm }
        // so the creator's bid page can follow it to the swap.
        const bid = await lookupBid(env, decodeURIComponent(bidGetMatch[1]));
        if (!bid) return json({ error: "not found" }, 404);
        return json(bid);
      }

      const getMatch = path.match(/^\/swap\/([^/]+)$/);
      if (getMatch && req.method === "GET") {
        await enforceRate(env.RL_READ, clientIp(req));
        const rec = await loadSwap(env, decodeURIComponent(getMatch[1]));
        if (!rec) return json({ error: "not found" }, 404);
        return json(rec);
      }

      if (path === "/list" && req.method === "GET") {
        // Authenticated + scoped: you may only list your OWN swaps. Every
        // participant is indexed by their nock pkh, so `idx:nock:<your pkh>:`
        // covers every swap you're part of — and nothing else is listable.
        const pkh = await requireSession(req, env);
        await enforceRate(env.RL_READ, clientIp(req));
        const prefix = url.searchParams.get("prefix") ?? "";
        if (prefix !== `idx:nock:${pkh}:`) {
          return json({ error: "may only list your own swaps" }, 403);
        }
        // Cursor-paginated straight from KV; the client follows `cursor` until
        // `complete` (capped client-side) instead of one server-side mega-loop.
        const limitRaw = Number(url.searchParams.get("limit") ?? "100");
        const limit = Math.min(Math.max(Math.floor(limitRaw) || 100, 1), 100);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const page = await env.SWAPS.list({ prefix, cursor, limit });
        return json({
          keys: page.keys.map((k) => k.name),
          cursor: page.list_complete ? undefined : page.cursor,
          complete: page.list_complete,
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
