/**
 * Minimal Cloudflare Worker exposing read/write/list over one KV namespace.
 * Intentionally tiny — "as little infrastructure as possible."
 *
 *   GET    /kv/:key         -> value (404 if missing)
 *   PUT    /kv/:key         -> store body (requires Bearer KV_TOKEN)
 *   DELETE /kv/:key         -> delete    (requires Bearer KV_TOKEN)
 *   GET    /list?prefix=... -> { keys: string[] }
 *
 * Reads/list are open (values are non-secret swap metadata). Writes require the
 * shared KV_TOKEN secret. This is coarse auth; per-user auth is a follow-up.
 * NEVER store the seller preimage here — it stays client-side (IndexedDB).
 */
export interface Env {
  SWAPS: KVNamespace;
  KV_TOKEN?: string;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function authorized(req: Request, env: Env): boolean {
  if (!env.KV_TOKEN) return true; // no token configured = open (dev only)
  const auth = req.headers.get("authorization");
  if (!auth) {
    console.log("No Authorization header");
    return false;
  }
  const expected = `Bearer ${env.KV_TOKEN}`;
  const matches = auth === expected;
  if (!matches) {
    console.log(`Auth mismatch: got "${auth}", expected "${expected.slice(0, 20)}..."`);
  }
  return matches;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    if (url.pathname === "/list" && req.method === "GET") {
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

    if (url.pathname.startsWith("/kv/")) {
      const key = decodeURIComponent(url.pathname.slice("/kv/".length));
      if (!key) return json({ error: "missing key" }, 400);

      if (req.method === "GET") {
        const value = await env.SWAPS.get(key);
        if (value === null) return new Response("not found", { status: 404, headers: CORS });
        return new Response(value, {
          headers: { "content-type": "text/plain", ...CORS },
        });
      }

      if (req.method === "PUT") {
        if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
        await env.SWAPS.put(key, await req.text());
        return json({ ok: true });
      }

      if (req.method === "DELETE") {
        if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
        await env.SWAPS.delete(key);
        return json({ ok: true });
      }
    }

    return json({ error: "not found" }, 404);
  },
};
