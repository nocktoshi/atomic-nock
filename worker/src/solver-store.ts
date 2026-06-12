/**
 * Solver tracking state — thin client over the Market Durable Object. The
 * KV-era per-pkh index keys + backfill machinery existed because KV list() is
 * rate-capped and eventually consistent; the DO's list is neither, so all of
 * that is gone. Per-pkh namespacing is preserved (a session can only touch its
 * own rows — the pkh comes from the authenticated session, never the body).
 */
import type { PnlEntry, TrackedSwap, TrackedSwapPatch } from "../../src/solver-state.js";
import { type Env } from "./swaps.js";
import { callMarket, callMarketOrNull, postJson } from "./market-client.js";

export function openExposureUsd(swaps: TrackedSwap[]): number {
  return swaps.filter((s) => !s.done).reduce((sum, s) => sum + (s.quoteUsd ?? 0), 0);
}

export async function listTrackedSwaps(env: Env, pkh: string): Promise<TrackedSwap[]> {
  const { swaps } = await callMarket<{ swaps: TrackedSwap[] }>(
    env,
    `/state/swaps?pkh=${encodeURIComponent(pkh)}`
  );
  return swaps;
}

export async function loadTrackedSwap(
  env: Env,
  pkh: string,
  hEvm: string
): Promise<TrackedSwap | null> {
  return callMarketOrNull<TrackedSwap>(
    env,
    `/state/swap?pkh=${encodeURIComponent(pkh)}&hEvm=${encodeURIComponent(hEvm)}`
  );
}

export async function upsertTrackedSwap(
  env: Env,
  pkh: string,
  swap: TrackedSwap
): Promise<TrackedSwap> {
  return callMarket<TrackedSwap>(env, "/state/swap", {
    ...postJson({ pkh, swap }),
    method: "PUT",
  });
}

export async function patchTrackedSwap(
  env: Env,
  pkh: string,
  hEvm: string,
  patch: TrackedSwapPatch
): Promise<TrackedSwap> {
  return callMarket<TrackedSwap>(env, "/state/swap", {
    ...postJson({ pkh, hEvm, patch }),
    method: "PATCH",
  });
}

export async function putSwapSecret(
  env: Env,
  pkh: string,
  hEvm: string,
  secretHex: string
): Promise<TrackedSwap> {
  return callMarket<TrackedSwap>(env, "/state/secret", {
    ...postJson({ pkh, hEvm, secretHex }),
    method: "PUT",
  });
}

export async function listPnl(env: Env, pkh: string): Promise<PnlEntry[]> {
  const { pnl } = await callMarket<{ pnl: PnlEntry[] }>(
    env,
    `/state/pnl?pkh=${encodeURIComponent(pkh)}`
  );
  return pnl;
}

export async function appendPnl(env: Env, pkh: string, entry: PnlEntry): Promise<void> {
  await callMarket(env, "/state/pnl", postJson({ pkh, entry }));
}

export function pnlSummary(pnl: PnlEntry[]): { nock: number; usd: number; count: number } {
  return pnl.reduce(
    (acc, e) => ({
      nock: acc.nock + (e.nockDelta ?? 0),
      usd: acc.usd + (e.usdDelta ?? 0),
      count: acc.count + 1,
    }),
    { nock: 0, usd: 0, count: 0 }
  );
}
