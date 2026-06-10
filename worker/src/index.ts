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
 *   POST /swap/:id/advance              -> party writes their progress fields
 *   GET  /swap/:id                      -> swap record
 *   GET  /kv/:key                       -> raw read (back-compat for the client)
 *   GET  /list?prefix=...               -> { keys: string[] }
 */
import {
  createSwap,
  claimSwap,
  advanceSwap,
  loadSwap,
  SwapError,
  type Env,
} from "./swaps.js";
import {
  makeChallenge,
  validateChallenge,
  issueToken,
  verifyToken,
  bearer,
} from "./session.js";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof SwapError) return json({ error: e.message }, e.status);
  console.error("worker error:", e);
  return json({ error: "internal error" }, 500);
}

/** Resolve the signed-in pkh from the bearer token, or throw 401. */
async function requireSession(req: Request, env: Env): Promise<string> {
  if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
  const pkh = await verifyToken(bearer(req), env.SESSION_SECRET);
  if (!pkh) throw new SwapError(401, "sign in required");
  return pkh;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // --- auth ---------------------------------------------------------------
      if (path === "/auth/challenge" && req.method === "GET") {
        if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
        const pkh = url.searchParams.get("pkh");
        if (!pkh) throw new SwapError(400, "missing pkh");
        return json(await makeChallenge(pkh, env.SESSION_SECRET));
      }

      if (path === "/auth/login" && req.method === "POST") {
        if (!env.SESSION_SECRET) throw new SwapError(500, "server not configured");
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
        const body = (await req.json()) as CreateBody;
        const rec = await createSwap(env, body.swap, pkh);
        return json({ ok: true, swap: rec });
      }

      const claimMatch = path.match(/^\/swap\/([^/]+)\/claim$/);
      if (claimMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        const body = (await req.json()) as ClaimBody;
        const rec = await claimSwap(env, decodeURIComponent(claimMatch[1]), body.buyerEth, pkh);
        return json({ ok: true, swap: rec });
      }

      const advanceMatch = path.match(/^\/swap\/([^/]+)\/advance$/);
      if (advanceMatch && req.method === "POST") {
        const pkh = await requireSession(req, env);
        const body = (await req.json()) as AdvanceBody;
        const rec = await advanceSwap(
          env,
          decodeURIComponent(advanceMatch[1]),
          body.fields,
          pkh,
          body.expectedVersion
        );
        return json({ ok: true, swap: rec });
      }

      // --- reads (open) -------------------------------------------------------
      const getMatch = path.match(/^\/swap\/([^/]+)$/);
      if (getMatch && req.method === "GET") {
        const rec = await loadSwap(env, decodeURIComponent(getMatch[1]));
        if (!rec) return json({ error: "not found" }, 404);
        return json(rec);
      }

      if (path === "/list" && req.method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const out: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.SWAPS.list({ prefix, cursor });
          for (const k of page.keys) out.push(k.name);
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return json({ keys: out });
      }

      // Back-compat raw read so the existing client read path keeps working.
      if (path.startsWith("/kv/") && req.method === "GET") {
        const key = decodeURIComponent(path.slice("/kv/".length));
        if (!key) return json({ error: "missing key" }, 400);
        const value = await env.SWAPS.get(key);
        if (value === null) {
          return new Response("not found", { status: 404, headers: CORS });
        }
        return new Response(value, {
          headers: { "content-type": "text/plain", ...CORS },
        });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
