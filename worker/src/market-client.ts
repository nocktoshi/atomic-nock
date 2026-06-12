/**
 * RPC client for the Market Durable Object. The worker authenticates and
 * rate-limits at the edge; coordination state lives in the DO.
 */
import { SwapError } from "./errors.js";
import type { Market } from "./market-do.js";
import type { Env } from "./swaps.js";
import { marketRpc } from "./rpc-errors.js";

export { marketRpc };

const MARKET_SINGLETON = "market";

export function marketStub(env: Env): DurableObjectStub<Market> {
  if (!env.MARKET_DO) throw new SwapError(500, "market DO not configured");
  return env.MARKET_DO.getByName(MARKET_SINGLETON);
}

/** Run an RPC method on the Market singleton. */
export function withMarket<T>(
  env: Env,
  fn: (stub: DurableObjectStub<Market>) => Promise<T>
): Promise<T> {
  return marketRpc(() => fn(marketStub(env)));
}