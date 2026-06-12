/**
 * 1Click supported-asset list (via the worker proxy), cached in-session. Powers
 * the "any asset" picker on the non-NOCK side of the swap box. NOCK itself is
 * never a 1Click asset — it's settled by the HTLC marketplace.
 */
import { KV_URL } from "../config.js";

export interface OneClickAsset {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

let cache: { at: number; assets: OneClickAsset[] } | null = null;
const TTL_MS = 5 * 60_000;

/** Fetch (and cache) the supported asset list. */
export async function listOneClickAssets(): Promise<OneClickAsset[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.assets;
  if (!KV_URL) return [];
  const res = await fetch(`${KV_URL.replace(/\/$/, "")}/oneclick/tokens`);
  if (!res.ok) throw new Error(`1Click tokens failed (${res.status})`);
  const assets = (await res.json()) as OneClickAsset[];
  cache = { at: Date.now(), assets };
  return assets;
}

/** Look up an asset by its nep141 id. */
export async function assetById(id: string): Promise<OneClickAsset | undefined> {
  return (await listOneClickAssets()).find((a) => a.assetId === id);
}

/** Human-friendly label, e.g. "USDC · Arbitrum". */
export function assetLabel(a: OneClickAsset): string {
  return `${a.symbol} · ${a.blockchain}`;
}

/** Convert a human amount string to the asset's atomic units. */
export function toAtomicUnits(amount: string, decimals: number): string {
  const [w, f = ""] = amount.trim().split(".");
  const frac = f.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}

/** Convert atomic units to a human number. */
export function fromAtomicUnits(atomic: string, decimals: number): number {
  return Number(atomic) / 10 ** decimals;
}
