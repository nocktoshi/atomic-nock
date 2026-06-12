import { describe, it, expect } from "vitest";
import { getMarketFeed } from "./feed.js";
import { createSwap, claimSwap } from "./swaps.js";
import { createBid } from "./bids.js";
import { marketEnv } from "./testing.js";

const baseSwap = {
  hEvm: "0xabc",
  hNock: "HN",
  sellerPkh: "SELLER",
  usdcTimelock: String(Math.floor(Date.now() / 1000) + 7200),
  nockGift: "3276800",
  nockRefundHeight: "1",
  sellerEth: "0xseller",
  usdcAmount: "1",
};

describe("market feed (Durable Object — always fresh)", () => {
  it("includes open swaps and bids in one response", async () => {
    const env = marketEnv();
    await createSwap(env, baseSwap, "SELLER");
    await createBid(
      env,
      {
        creatorEth: "0x1111111111111111111111111111111111111111",
        token: "USDC",
        quoteAmount: "10",
        nockGift: "3276800",
      },
      "BUYER"
    );
    const feed = await getMarketFeed(env);
    expect(feed.swaps.map((s) => s.hEvm)).toEqual(["0xabc"]);
    expect(feed.bids).toHaveLength(1);
    expect(feed.bids[0].creatorPkh).toBe("BUYER");
    expect(typeof feed.ts).toBe("number");
  });

  it("reflects a claim IMMEDIATELY (no snapshot, no invalidation hooks)", async () => {
    const env = marketEnv();
    await createSwap(env, baseSwap, "SELLER");
    expect((await getMarketFeed(env)).swaps).toHaveLength(1);
    await claimSwap(env, "0xabc", "0xbuyer", "BUYER");
    expect((await getMarketFeed(env)).swaps).toHaveLength(0);
  });
});
