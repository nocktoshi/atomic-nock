import { describe, it, expect } from "vitest";
import { createBid, listBids, cancelBid, fillBid, loadBid, lookupBid } from "./bids.js";
import { cancelSwap, loadSwap, type Env } from "./swaps.js";

/** In-memory KV mock (same shape as swaps.test.ts). */
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

const BIDDER = "BIDDER_PKH";
const FILLER = "FILLER_PKH";
const goodBid = {
  token: "WNOCK",
  quoteAmount: "49.5",
  nockGift: "3276800",
  creatorEth: "0x1111111111111111111111111111111111111111",
};

/** What the filler's client posts after generating the secret. */
const fillerSwap = {
  hEvm: "0xfeed",
  hNock: "HN",
  sellerPkh: FILLER,
  usdcTimelock: "9999999999",
  nockGift: "3276800",
  nockRefundHeight: "1000",
  sellerEth: "0x2222222222222222222222222222222222222222",
  usdcAmount: "49.5",
  token: "WNOCK",
};

describe("createBid", () => {
  it("creates a bid bound to the session pkh", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);
    expect(bid.creatorPkh).toBe(BIDDER);
    expect(bid.id).toMatch(/^[0-9a-f]{32}$/);
    expect(await loadBid(env, bid.id)).toMatchObject({ token: "WNOCK", quoteAmount: "49.5" });
  });

  it.each([
    [{ ...goodBid, token: "DOGE" }, /unknown token/],
    [{ ...goodBid, quoteAmount: "-5" }, /quoteAmount/],
    [{ ...goodBid, quoteAmount: "0" }, /quoteAmount/],
    [{ ...goodBid, nockGift: "1.5" }, /nockGift/],
    [{ ...goodBid, nockGift: "65536" }, /10 NOCK/],
    [{ ...goodBid, creatorEth: "nope" }, /creatorEth/],
  ])("rejects invalid input %#", async (body, err) => {
    await expect(createBid(fakeEnv(), body, BIDDER)).rejects.toThrow(err);
  });
});

describe("listBids", () => {
  it("lists open bids newest first", async () => {
    const env = fakeEnv();
    const a = await createBid(env, { ...goodBid }, BIDDER);
    const b = await createBid(env, { ...goodBid, quoteAmount: "50" }, BIDDER);
    // Force distinct createdAt ordering.
    const recB = JSON.parse(env.store.get(`bid:${b.id}`)!);
    recB.createdAt += 10;
    env.store.set(`bid:${b.id}`, JSON.stringify(recB));

    const bids = await listBids(env);
    expect(bids.map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("cancelBid", () => {
  it("creator can cancel; others cannot", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);
    await expect(cancelBid(env, bid.id, FILLER)).rejects.toThrow(/creator/);
    await cancelBid(env, bid.id, BIDDER);
    expect(await loadBid(env, bid.id)).toBeNull();
  });
});

describe("fillBid", () => {
  it("converts the bid into a swap with forced economics and deletes the bid", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);

    const { swap } = await fillBid(
      env,
      bid.id,
      // Tampered economics: the worker must override them all from the bid.
      { ...fillerSwap, usdcAmount: "0.01", nockGift: "999", token: "USDC", buyerPkh: "EVIL" },
      FILLER
    );

    expect(swap.sellerPkh).toBe(FILLER);
    expect(swap.buyerPkh).toBe(BIDDER);
    expect(swap.buyerEth).toBe(goodBid.creatorEth);
    expect(swap.usdcAmount).toBe("49.5");
    expect(swap.nockGift).toBe("3276800");
    expect(swap.token).toBe("WNOCK");
    expect(await loadBid(env, bid.id)).toBeNull();
    // The tombstone routes the creator's bid page to the swap that replaced it.
    expect(await lookupBid(env, bid.id)).toEqual({ filledHEvm: "0xfeed" });
    // No open-marketplace index: the swap is born with a committed buyer.
    expect(env.store.has(`idx:open:${String(swap.hEvm).toLowerCase()}`)).toBe(false);
    // Both participants are indexed.
    expect(env.store.has(`idx:nock:${FILLER}:0xfeed`)).toBe(true);
    expect(env.store.has(`idx:nock:${BIDDER}:0xfeed`)).toBe(true);
  });

  it("rejects filling your own bid and missing bids", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);
    await expect(fillBid(env, bid.id, { ...fillerSwap }, BIDDER)).rejects.toThrow(/own bid/);
    await expect(fillBid(env, "deadbeef", { ...fillerSwap }, FILLER)).rejects.toThrow(/not found/);
  });

  it("requires the seller session to match the posted swap", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);
    await expect(
      fillBid(env, bid.id, { ...fillerSwap, sellerPkh: "SOMEONE_ELSE" }, FILLER)
    ).rejects.toThrow(/sellerPkh/);
  });
});

describe("cancelSwap on a filled-bid swap", () => {
  it("either participant can cancel while nothing is on-chain", async () => {
    const env = fakeEnv();
    const bid = await createBid(env, { ...goodBid }, BIDDER);
    await fillBid(env, bid.id, { ...fillerSwap }, FILLER);

    await expect(cancelSwap(env, "0xfeed", "STRANGER")).rejects.toThrow(/participant/);
    await cancelSwap(env, "0xfeed", BIDDER); // buyer backs out pre-lock
    expect(await loadSwap(env, "0xfeed")).toBeNull();
    expect(env.store.has(`idx:nock:${FILLER}:0xfeed`)).toBe(false);
    expect(env.store.has(`idx:nock:${BIDDER}:0xfeed`)).toBe(false);
  });
});
