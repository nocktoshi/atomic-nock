/**
 * NEAR Intents 1Click proxy. The browser calls our worker; the worker adds the
 * distribution-channel JWT (removing the 0.2% platform fee) and our appFees,
 * then forwards to 1Click. This keeps the JWT secret (never in the frontend
 * bundle) AND makes the app-fee non-strippable by a tampering client.
 *
 * The core NOCK↔USDC HTLC swap never touches 1Click — this is only for the
 * optional "any asset/chain" entry/exit hops.
 */
import type { Env } from "./swaps.js";

const DEFAULT_BASE = "https://1click.chaindefuser.com";

/** App fee (NEAR recipient + bps) injected server-side, if configured. */
function appFees(env: Env): Array<{ recipient: string; fee: number }> {
  const recipient = env.ONECLICK_APPFEE_RECIPIENT?.trim();
  const bps = Number(env.ONECLICK_APPFEE_BPS ?? "0");
  if (!recipient || !Number.isFinite(bps) || bps <= 0) return [];
  return [{ recipient, fee: Math.min(Math.floor(bps), 500) }];
}

/** Forward a quote request to 1Click with our JWT + appFees attached. */
export async function oneClickQuote(env: Env, body: Record<string, unknown>): Promise<Response> {
  const base = (env.ONECLICK_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const fees = appFees(env);
  const payload = fees.length ? { ...body, appFees: fees } : body;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.ONECLICK_JWT) headers.authorization = `Bearer ${env.ONECLICK_JWT}`;

  const res = await fetch(`${base}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  // Pass the 1Click response straight through (status + body).
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

/** Forward a read-only GET (status, tokens, …) to 1Click with the JWT. */
export async function oneClickGet(env: Env, subpath: string, search: string): Promise<Response> {
  const base = (env.ONECLICK_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (env.ONECLICK_JWT) headers.authorization = `Bearer ${env.ONECLICK_JWT}`;
  const res = await fetch(`${base}/v0/${subpath}${search}`, { headers });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

/** Forward a deposit-submit POST (tracks a user's deposit) to 1Click. */
export async function oneClickPost(env: Env, subpath: string, body: unknown): Promise<Response> {
  const base = (env.ONECLICK_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.ONECLICK_JWT) headers.authorization = `Bearer ${env.ONECLICK_JWT}`;
  const res = await fetch(`${base}/v0/${subpath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
