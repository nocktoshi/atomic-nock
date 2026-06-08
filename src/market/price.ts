import { PRICE_URL } from "../config.js";
import type { SwapPublic } from "../swap.js";

const NICKS_PER_NOCK = 65536;

export interface PriceProvider {
  /** Current NOCK price in USD, or null if unavailable. */
  getNockUsd(): Promise<number | null>;
}

/** Pull a USD number out of a few common JSON shapes (CoinGecko etc.). */
function extractUsd(data: unknown): number | null {
  if (typeof data === "number") return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    // CoinGecko simple/price: { nock: { usd: 1.23 } }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object" && typeof (v as any).usd === "number") {
        return (v as any).usd;
      }
    }
    if (typeof o.usd === "number") return o.usd;
    if (typeof o.price === "number") return o.price;
  }
  return null;
}

/**
 * Default provider: fetches from VITE_PRICE_URL with a short cache, degrading to
 * null (price hidden) when unset or on any error.
 */
export function createPriceProvider(
  url: string = PRICE_URL,
  fetcher: typeof fetch = fetch,
  ttlMs = 60_000
): PriceProvider {
  let cache: { value: number | null; at: number } | null = null;

  return {
    async getNockUsd() {
      if (!url) return null;
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) return cache.value;
      let value: number | null = null;
      try {
        const res = await fetcher(url);
        if (res.ok) value = extractUsd(await res.json());
      } catch {
        value = null;
      }
      cache = { value: value != null && isFinite(value) ? value : null, at: now };
      return cache.value;
    },
  };
}

/** Implied NOCK/USD price from a swap's own amounts (USDC ≈ USD). */
export function impliedNockUsd(swap: SwapPublic): number | null {
  if (!swap.usdcAmount) return null;
  const usdc = Number(swap.usdcAmount);
  const nock = Number(swap.nockGift) / NICKS_PER_NOCK;
  if (!isFinite(usdc) || !isFinite(nock) || nock <= 0) return null;
  return usdc / nock;
}
