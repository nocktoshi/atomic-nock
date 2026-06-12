/**
 * Test doubles for the Market DO: Map-backed storage (the DO's whole storage
 * contract — no miniflare needed) and an Env whose MARKET_DO stub routes
 * straight into a real MarketCore instance via RPC-shaped method calls.
 */
import { MarketCore, type MarketStorage } from "./market.js";
import type { Market } from "./market-do.js";
import { throwRpcError } from "./rpc-errors.js";
import type { Env } from "./swaps.js";

/** Wrap MarketCore like the Market DO RPC boundary (encode SwapError for RPC). */
function marketRpcStub(core: MarketCore): DurableObjectStub<Market> {
  return new Proxy(core, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          throwRpcError(e);
        }
      };
    },
  }) as unknown as DurableObjectStub<Market>;
}

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

export type MarketEnv = Env & { market: MarketCore; raw: Map<string, unknown> };

/** Env whose MARKET_DO namespace routes into MarketCore (RPC surface). */
export function marketEnv(): MarketEnv {
  const storage = fakeMarketStorage();
  const core = new MarketCore(storage);
  const stub = marketRpcStub(core);
  const MARKET_DO = {
    getByName: () => stub,
    get: () => stub,
    idFromName: () => "market-id",
  };
  return { MARKET_DO, market: core, raw: storage.raw } as unknown as MarketEnv;
}