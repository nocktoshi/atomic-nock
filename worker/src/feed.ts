/**
 * Marketplace feed — served straight from the Market Durable Object, which is
 * strongly consistent. The KV-era snapshot cache + invalidation hooks (and the
 * expirationTtl-minimum bug class that came with them) are gone: every read is
 * fresh, and the DO prunes stale open orders inline.
 */
import type { BidRecord } from "./market.js";
import type { SwapRecord } from "./contract.js";
import type { Env } from "./swaps.js";
import { withMarket } from "./market-client.js";

export interface MarketFeed {
  swaps: SwapRecord[];
  bids: BidRecord[];
  ts: number;
}

export async function getMarketFeed(env: Env, limit = 50): Promise<MarketFeed> {
  return withMarket(env, (stub) => stub.feed(Math.floor(limit) || 50));
}