/**
 * Buy orders ("bids") — thin client over the Market Durable Object. A bid has
 * no hashlock; on fill it converts into a normal swap ATOMICALLY inside the DO
 * (the KV implementation documented a cross-colo double-fill race — that race
 * is structurally gone). Function surface unchanged; see market.ts for logic.
 */
import { type Env } from "./swaps.js";
import type { SwapRecord } from "./contract.js";
import type { BidRecord } from "./market.js";
import { callMarket, callMarketOrNull, postJson } from "./market-client.js";

export type { BidRecord };

export async function lookupBid(
  env: Env,
  id: string
): Promise<BidRecord | { filledHEvm: string } | null> {
  return callMarketOrNull<BidRecord | { filledHEvm: string }>(
    env,
    `/bid/get?id=${encodeURIComponent(id)}`
  );
}

export async function createBid(
  env: Env,
  body: Record<string, unknown>,
  sessionPkh: string
): Promise<BidRecord> {
  return callMarket<BidRecord>(env, "/bid/create", postJson({ bid: body, sessionPkh }));
}

export async function cancelBid(env: Env, id: string, sessionPkh: string): Promise<void> {
  await callMarket(env, "/bid/cancel", postJson({ id, sessionPkh }));
}

export async function fillBid(
  env: Env,
  id: string,
  swap: Record<string, unknown>,
  sessionPkh: string
): Promise<{ swap: SwapRecord; bid: BidRecord }> {
  return callMarket<{ swap: SwapRecord; bid: BidRecord }>(
    env,
    "/bid/fill",
    postJson({ id, swap, sessionPkh })
  );
}
