/**
 * Thin client for the Market Durable Object. The worker authenticates and
 * rate-limits at the edge; all coordination state lives in the DO (see
 * market.ts for why). Errors round-trip as SwapError(status, message).
 */
import { SwapError } from "./errors.js";
import type { Env } from "./swaps.js";

export function marketStub(env: Env): DurableObjectStub {
  if (!env.MARKET_DO) throw new SwapError(500, "market DO not configured");
  return env.MARKET_DO.get(env.MARKET_DO.idFromName("market"));
}

/** Call an internal Market route; throws SwapError on any non-2xx response. */
export async function callMarket<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await marketStub(env).fetch(`https://market${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new SwapError(res.status, body.error ?? `market call failed (${res.status})`);
  return body;
}

/** Like callMarket but maps 404 to null instead of throwing. */
export async function callMarketOrNull<T>(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<T | null> {
  const res = await marketStub(env).fetch(`https://market${path}`, init);
  if (res.status === 404) return null;
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new SwapError(res.status, body.error ?? `market call failed (${res.status})`);
  return body;
}

export function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
