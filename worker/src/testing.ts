/**
 * Test doubles for the Market DO: Map-backed storage (the DO's whole storage
 * contract — no miniflare needed) and an Env whose MARKET_DO stub routes
 * straight into a real Market instance, so the worker-side client modules are
 * exercised end-to-end in unit tests.
 */
import { Market, type MarketStorage } from "./market.js";
import type { Env } from "./swaps.js";

export function fakeMarketStorage(): MarketStorage & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    async get<T>(key: string) {
      return raw.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      // Deep-copy so callers can't mutate stored state through references —
      // matches the serialization boundary of real DO storage.
      raw.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return raw.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of [...raw].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (k.startsWith(prefix)) out.set(k, structuredClone(v) as T);
      }
      return out;
    },
  };
}

export type MarketEnv = Env & { market: Market; raw: Map<string, unknown> };

/** Env whose MARKET_DO namespace routes into a real Market over fake storage. */
export function marketEnv(): MarketEnv {
  const storage = fakeMarketStorage();
  const market = new Market({ storage });
  const stub = {
    fetch: (url: string, init?: RequestInit) => market.fetch(new Request(url, init)),
  };
  const MARKET_DO = {
    idFromName: () => "market-id",
    get: () => stub,
  };
  return { MARKET_DO, market, raw: storage.raw } as unknown as MarketEnv;
}
