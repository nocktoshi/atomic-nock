import { describe, it, expect } from "vitest";
import type { Env } from "./swaps.js";
import { FEED_KEY, getMarketFeed, invalidateMarketFeed, refreshMarketFeed } from "./feed.js";
import { createSwap } from "./swaps.js";
import { createBid } from "./bids.js";

function fakeEnv(): Env & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const SWAPS = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  };
  return { SWAPS, store } as unknown as Env & { store: Map<string, string> };
}

const baseSwap = {
  hEvm: "0xabc",
  hNock: "HN",
  sellerPkh: "SELLER",
  usdcTimelock: String(Math.floor(Date.now() / 1000) + 7200),
  nockGift: "100",
  nockRefundHeight: "1",
  sellerEth: "0xseller",
  usdcAmount: "1",
};

describe("market feed cache", () => {
  it("serves from KV without rescanning indexes while fresh", async () => {
    const env = fakeEnv();
    await createSwap(env, baseSwap, "SELLER");
    await refreshMarketFeed(env);
    env.store.delete("idx:open:0xabc");

    const feed = await getMarketFeed(env);
    expect(feed.swaps).toHaveLength(1);
    expect(env.store.has(FEED_KEY)).toBe(true);
  });

  it("rebuilds after invalidation", async () => {
    const env = fakeEnv();
    await createSwap(env, baseSwap, "SELLER");
    await refreshMarketFeed(env);
    await invalidateMarketFeed(env);
    expect(env.store.has(FEED_KEY)).toBe(false);

    const feed = await getMarketFeed(env);
    expect(feed.swaps).toHaveLength(1);
  });

  it("includes bids in the snapshot", async () => {
    const env = fakeEnv();
    await createBid(
      env,
      {
        creatorEth: "0x1111111111111111111111111111111111111111",
        token: "USDC",
        quoteAmount: "10",
        nockGift: "1000",
      },
      "BUYER"
    );
    const feed = await getMarketFeed(env);
    expect(feed.bids).toHaveLength(1);
    expect(feed.bids[0].creatorPkh).toBe("BUYER");
  });
});