/**
 * Cached marketplace snapshot (open asks + bids). Pollers hit one KV read
 * instead of scanning idx:open: and bid: on every request. Invalidated on
 * any mutation that changes the order book.
 */
import type { BidRecord } from "./bids.js";
import { listBids } from "./bids.js";
import type { SwapRecord } from "./contract.js";
import { listOpenSwaps, type Env } from "./swaps.js";

export const FEED_KEY = "market:feed";
/** Reuse a snapshot this long before rebuilding (solver polls ~4s). */
const FEED_TTL_MS = 5_000;
/** KV garbage collection only — freshness comes from `ts` above. Cloudflare KV
 *  rejects expirationTtl below 60s, so this must stay >= 60. */
const FEED_KV_TTL_SEC = 60;
const MAX_ITEMS = 50;

export interface MarketFeed {
  swaps: SwapRecord[];
  bids: BidRecord[];
  ts: number;
}

function capLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit) || MAX_ITEMS, 1), MAX_ITEMS);
}

function sliceFeed(feed: MarketFeed, limit: number): MarketFeed {
  const capped = capLimit(limit);
  return {
    swaps: feed.swaps.slice(0, capped),
    bids: feed.bids.slice(0, capped),
    ts: feed.ts,
  };
}

/** Drop the cached snapshot so the next read rebuilds from indexes. */
export async function invalidateMarketFeed(env: Env): Promise<void> {
  await env.SWAPS.delete(FEED_KEY).catch(() => {});
}

/** Build a fresh snapshot from KV indexes and store it. */
export async function refreshMarketFeed(env: Env): Promise<MarketFeed> {
  const [open, bids] = await Promise.all([
    listOpenSwaps(env, undefined, MAX_ITEMS),
    listBids(env, MAX_ITEMS),
  ]);
  const feed: MarketFeed = { swaps: open.swaps, bids, ts: Date.now() };
  // The snapshot write is an optimization — never let it fail the read path.
  await env.SWAPS.put(FEED_KEY, JSON.stringify(feed), { expirationTtl: FEED_KV_TTL_SEC }).catch(() => {});
  return feed;
}

/** Cached marketplace feed; rebuilds when missing or stale. */
export async function getMarketFeed(env: Env, limit = MAX_ITEMS): Promise<MarketFeed> {
  const raw = await env.SWAPS.get(FEED_KEY);
  if (raw) {
    try {
      const cached = JSON.parse(raw) as MarketFeed;
      if (Date.now() - cached.ts < FEED_TTL_MS) return sliceFeed(cached, limit);
    } catch {
      /* corrupt cache — rebuild */
    }
  }
  return sliceFeed(await refreshMarketFeed(env), limit);
}