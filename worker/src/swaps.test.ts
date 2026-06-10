import { describe, it, expect } from "vitest";
import { createSwap, claimSwap, advanceSwap, type Env } from "./swaps.js";

/** In-memory KV mock for the Worker's Env. */
function fakeEnv(): Env {
  const store = new Map<string, string>();
  const SWAPS = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  };
  return { SWAPS } as unknown as Env;
}

const SELLER = "SELLER_PKH";
const BUYER = "BUYER_PKH";
const baseSwap = {
  hEvm: "0xabc",
  hNock: "HN",
  sellerPkh: SELLER,
  usdcTimelock: "1",
  nockGift: "100",
  nockRefundHeight: "1",
  sellerEth: "0xseller",
  usdcAmount: "1",
};

async function seedClaimed(): Promise<Env> {
  const env = fakeEnv();
  await createSwap(env, { ...baseSwap }, SELLER);
  await claimSwap(env, "0xabc", "0xbuyer", BUYER);
  return env;
}

describe("advanceSwap ordering invariants", () => {
  it("buyer cannot lock USDC before the seller locks NOCK", async () => {
    const env = await seedClaimed();
    await expect(
      advanceSwap(env, "0xabc", { usdcLockTxHash: "0xul" }, BUYER)
    ).rejects.toThrow(/before "lockFirstName"/);
  });

  it("seller cannot withdraw before the buyer locks USDC", async () => {
    const env = await seedClaimed();
    await advanceSwap(env, "0xabc", { lockFirstName: "LFN" }, SELLER);
    await expect(
      advanceSwap(env, "0xabc", { usdcWithdrawTxHash: "0xuw" }, SELLER)
    ).rejects.toThrow(/before "usdcLockTxHash"/);
  });

  it("walks the full happy path in order", async () => {
    const env = await seedClaimed();
    await advanceSwap(env, "0xabc", { lockFirstName: "LFN", nockLockTxId: "0xnl" }, SELLER);
    await advanceSwap(env, "0xabc", { usdcLockTxHash: "0xul" }, BUYER);
    await advanceSwap(env, "0xabc", { usdcWithdrawTxHash: "0xuw" }, SELLER);
    const rec = await advanceSwap(env, "0xabc", { nockClaimTxId: "0xnc" }, BUYER);
    expect(rec.nockClaimTxId).toBe("0xnc");
    expect(rec.version).toBe(6); // create=1, claim=2, +4 advances
  });

  it("seller cannot withdraw after the buyer has refunded (conflict)", async () => {
    const env = await seedClaimed();
    await advanceSwap(env, "0xabc", { lockFirstName: "LFN" }, SELLER);
    await advanceSwap(env, "0xabc", { usdcLockTxHash: "0xul" }, BUYER);
    await advanceSwap(env, "0xabc", { usdcRefundTxHash: "0xrf" }, BUYER);
    await expect(
      advanceSwap(env, "0xabc", { usdcWithdrawTxHash: "0xuw" }, SELLER)
    ).rejects.toThrow(/"usdcRefundTxHash" is already set/);
  });

  it("a non-participant cannot advance", async () => {
    const env = await seedClaimed();
    await expect(
      advanceSwap(env, "0xabc", { usdcLockTxHash: "0xul" }, "STRANGER_PKH")
    ).rejects.toThrow(/not a participant/);
  });
});
