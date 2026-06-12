import type { MarketStorage } from "./market.js";

/** Adapt Durable Object storage to the MarketStorage seam used by MarketCore. */
export function doMarketStorage(storage: DurableObjectStorage): MarketStorage {
  return {
    async get<T>(key: string) {
      const v = await storage.get<T>(key);
      return v ?? undefined;
    },
    async put<T>(key: string, value: T) {
      await storage.put(key, value);
    },
    async delete(key: string) {
      return await storage.delete(key);
    },
    async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
      const page = await storage.list<T>({ prefix, limit: limit ?? 1000 });
      return new Map(page);
    },
  };
}