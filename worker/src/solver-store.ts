/**
 * Solver tracking state in KV — per-swap keys + a P&L ledger per pkh.
 * Read-heavy poll loops stay on the solver's RAM cache; these ops run at
 * startup (hydrate) and on lifecycle events (write-through).
 */
import type { PnlEntry, TrackedSwap, TrackedSwapPatch } from "../../src/solver-state.js";
import { SwapError, type Env } from "./swaps.js";

const SWAP_PREFIX = "solver:swap:";
const PNL_PREFIX = "solver:pnl:";

const id = (hEvm: string) => hEvm.toLowerCase();

function swapKey(pkh: string, hEvm: string): string {
  return `${SWAP_PREFIX}${pkh}:${id(hEvm)}`;
}

function pnlKey(pkh: string): string {
  return `${PNL_PREFIX}${pkh}`;
}

export function openExposureUsd(swaps: TrackedSwap[]): number {
  return swaps.filter((s) => !s.done).reduce((sum, s) => sum + s.quoteUsd, 0);
}

export async function listTrackedSwaps(env: Env, pkh: string): Promise<TrackedSwap[]> {
  const prefix = `${SWAP_PREFIX}${pkh}:`;
  const page = await env.SWAPS.list({ prefix });
  const raw = await Promise.all(page.keys.map((k) => env.SWAPS.get(k.name)));
  return raw
    .filter((r): r is string => r != null)
    .map((r) => JSON.parse(r) as TrackedSwap);
}

export async function loadTrackedSwap(
  env: Env,
  pkh: string,
  hEvm: string
): Promise<TrackedSwap | null> {
  const raw = await env.SWAPS.get(swapKey(pkh, hEvm));
  return raw ? (JSON.parse(raw) as TrackedSwap) : null;
}

export async function upsertTrackedSwap(
  env: Env,
  pkh: string,
  swap: TrackedSwap
): Promise<TrackedSwap> {
  if (!swap.hEvm) throw new SwapError(400, "missing hEvm");
  const next: TrackedSwap = { ...swap, updatedAt: Date.now() };
  await env.SWAPS.put(swapKey(pkh, next.hEvm), JSON.stringify(next));
  return next;
}

export async function patchTrackedSwap(
  env: Env,
  pkh: string,
  hEvm: string,
  fields: TrackedSwapPatch
): Promise<TrackedSwap> {
  const prev = await loadTrackedSwap(env, pkh, hEvm);
  if (!prev) throw new SwapError(404, "swap not tracked");
  const next: TrackedSwap = {
    ...prev,
    updatedAt: fields.updatedAt ?? Date.now(),
    ...(fields.phase !== undefined && { phase: fields.phase }),
    ...(fields.done !== undefined && { done: fields.done }),
    ...(fields.lockSeenHeight !== undefined && { lockSeenHeight: fields.lockSeenHeight }),
    ...(fields.consolidatedAt !== undefined && { consolidatedAt: fields.consolidatedAt }),
    ...(fields.quoteUsd !== undefined && { quoteUsd: fields.quoteUsd }),
    ...(fields.nockNicks !== undefined && { nockNicks: fields.nockNicks }),
  };
  await env.SWAPS.put(swapKey(pkh, hEvm), JSON.stringify(next));
  return next;
}

export async function putSwapSecret(
  env: Env,
  pkh: string,
  hEvm: string,
  secretHex: string
): Promise<TrackedSwap> {
  if (!/^[0-9a-f]+$/i.test(secretHex) || secretHex.length % 2 !== 0) {
    throw new SwapError(400, "secretHex must be even-length hex");
  }
  const prev = await loadTrackedSwap(env, pkh, hEvm);
  if (!prev) throw new SwapError(404, "swap not tracked");
  const next: TrackedSwap = { ...prev, secretHex, updatedAt: Date.now() };
  await env.SWAPS.put(swapKey(pkh, hEvm), JSON.stringify(next));
  return next;
}

export async function listPnl(env: Env, pkh: string): Promise<PnlEntry[]> {
  const raw = await env.SWAPS.get(pnlKey(pkh));
  return raw ? (JSON.parse(raw) as PnlEntry[]) : [];
}

export async function appendPnl(env: Env, pkh: string, entry: PnlEntry): Promise<PnlEntry> {
  if (!entry.hEvm || !Number.isFinite(entry.ts)) throw new SwapError(400, "bad pnl entry");
  const prev = await listPnl(env, pkh);
  const next = [...prev, entry];
  await env.SWAPS.put(pnlKey(pkh), JSON.stringify(next));
  return entry;
}

export function pnlSummary(entries: PnlEntry[]): { nock: number; usd: number; count: number } {
  return entries.reduce(
    (acc, e) => ({ nock: acc.nock + e.nockDelta, usd: acc.usd + e.usdDelta, count: acc.count + 1 }),
    { nock: 0, usd: 0, count: 0 }
  );
}