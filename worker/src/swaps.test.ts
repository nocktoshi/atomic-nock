import { describe, it, expect } from "vitest";
import {
  createSwap,
  claimSwap,
  advanceSwap,
  cancelSwap,
} from "./swaps.js";
import { enforceRate } from "./ratelimit.js";
import { marketEnv, type MarketEnv } from "./testing.js";

/** All swap state lives in the Market DO; tests route through a real instance. */
const fakeEnv = (): MarketEnv => marketEnv();

async function listOpenSwaps(env: MarketEnv) {
  return { swaps: await env.market.listOpenSwaps() };
}

const SELLER = "SELLER_PKH";
const BUYER = "BUYER_PKH";
const baseSwap = {
  hEvm: "0xabc",
  hNock: "HN",
  sellerPkh: SELLER,
  usdcTimelock: "1",
  nockGift: "655360",
  nockRefundHeight: "1",
  sellerEth: "0xseller",
  usdcAmount: "1",
};

async function seedClaimed(): Promise<ReturnType<typeof fakeEnv>> {
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

describe("multi-asset token field", () => {
  it("accepts WNOCK and stores it", async () => {
    const env = fakeEnv();
    const rec = await createSwap(env, { ...baseSwap, token: "WNOCK" }, SELLER);
    expect(rec.token).toBe("WNOCK");
  });

  it("accepts records with no token (legacy = USDC)", async () => {
    const env = fakeEnv();
    const rec = await createSwap(env, { ...baseSwap }, SELLER);
    expect(rec.token).toBeUndefined();
  });

  it("rejects unknown tokens", async () => {
    const env = fakeEnv();
    await expect(
      createSwap(env, { ...baseSwap, token: "DOGE" }, SELLER)
    ).rejects.toThrow(/unknown token/);
  });

  it("token is immutable after create", async () => {
    const env = await seedClaimed();
    await expect(
      advanceSwap(env, "0xabc", { token: "WNOCK" }, SELLER)
    ).rejects.toThrow(/immutable/);
  });
});

describe("record housekeeping", () => {
  it("stamps server-side createdAt at create", async () => {
    const env = fakeEnv();
    const before = Math.floor(Date.now() / 1000);
    const rec = await createSwap(env, { ...baseSwap }, SELLER);
    expect(typeof rec.createdAt).toBe("number");
    expect(rec.createdAt as number).toBeGreaterThanOrEqual(before);
  });

  it("createdAt is immutable after create", async () => {
    const env = await seedClaimed();
    await expect(
      advanceSwap(env, "0xabc", { createdAt: 1 }, SELLER)
    ).rejects.toThrow(/immutable/);
  });

  it("indexes both participants under mine: keys (replaces KV idx:nock)", async () => {
    const env = await seedClaimed();
    expect(env.raw.has("mine:SELLER_PKH:0xabc")).toBe(true);
    expect(env.raw.has("mine:BUYER_PKH:0xabc")).toBe(true);
  });

  it("stamps updatedAt on every write (drives the 30-day sweep)", async () => {
    const env = await seedClaimed();
    const rec = env.raw.get("swap:0xabc") as { updatedAt?: number };
    expect(typeof rec.updatedAt).toBe("number");
  });
});

describe("marketplace (open swaps)", () => {
  const future = String(Math.floor(Date.now() / 1000) + 12 * 3600);
  const openSwap = { ...baseSwap, usdcTimelock: future };

  it("lists an open swap; claiming delists it", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    let { swaps } = await listOpenSwaps(env);
    expect(swaps.map((s) => s.hEvm)).toEqual(["0xabc"]);

    await claimSwap(env, "0xabc", "0xbuyer", BUYER);
    ({ swaps } = await listOpenSwaps(env));
    expect(swaps).toEqual([]);
  });

  it("a directed swap (buyer preset) is never listed", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap, buyerPkh: BUYER }, SELLER);
    const { swaps } = await listOpenSwaps(env);
    expect(swaps).toEqual([]);
  });

  it("filters orders whose quote window is nearly over", async () => {
    const env = fakeEnv();
    const soon = String(Math.floor(Date.now() / 1000) + 60); // < 1h left
    await createSwap(env, { ...openSwap, usdcTimelock: soon }, SELLER);
    const { swaps } = await listOpenSwaps(env);
    expect(swaps).toEqual([]);
  });

  it("seller can cancel an unclaimed swap; record + indexes removed", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await cancelSwap(env, "0xabc", SELLER);
    const { swaps } = await listOpenSwaps(env);
    expect(swaps).toEqual([]);
    expect(env.raw.get("swap:0xabc")).toBeUndefined();
    expect([...env.raw.keys()].filter((k) => k.includes("0xabc"))).toEqual([]);
  });

  it("only a participant can cancel", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await expect(cancelSwap(env, "0xabc", "STRANGER")).rejects.toMatchObject({ status: 403 });
  });

  it("either participant can cancel a claimed swap while nothing is on-chain", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await claimSwap(env, "0xabc", "0xbuyer", BUYER);
    await cancelSwap(env, "0xabc", BUYER);
    expect(env.raw.get("swap:0xabc")).toBeUndefined();
    expect([...env.raw.keys()].filter((k) => k.includes("0xabc"))).toEqual([]);
  });

  it("cannot cancel after NOCK is locked", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await claimSwap(env, "0xabc", "0xbuyer", BUYER);
    await advanceSwap(env, "0xabc", { lockFirstName: "LFN" }, SELLER);
    await expect(cancelSwap(env, "0xabc", SELLER)).rejects.toMatchObject({ status: 409 });
  });

  it("lists newest first", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap, hEvm: "0xold" }, SELLER);
    // Force distinct createdAt stamps.
    const oldRec = env.raw.get("swap:0xold") as { createdAt: number };
    oldRec.createdAt -= 100;
    env.raw.set("swap:0xold", oldRec);
    await createSwap(env, { ...openSwap, hEvm: "0xnew" }, SELLER);
    const { swaps } = await listOpenSwaps(env);
    expect(swaps.map((s) => s.hEvm)).toEqual(["0xnew", "0xold"]);
  });
});

describe("enforceRate", () => {
  it("is a no-op when the binding is absent", async () => {
    await expect(enforceRate(undefined, "k")).resolves.toBeUndefined();
  });

  it("passes under the limit", async () => {
    await expect(
      enforceRate({ limit: async () => ({ success: true }) }, "k")
    ).resolves.toBeUndefined();
  });

  it("throws 429 over the limit", async () => {
    await expect(
      enforceRate({ limit: async () => ({ success: false }) }, "k")
    ).rejects.toMatchObject({ status: 429 });
  });

  it("never blocks when the limiter itself fails", async () => {
    await expect(
      enforceRate(
        { limit: async () => { throw new Error("limiter down"); } },
        "k"
      )
    ).resolves.toBeUndefined();
  });
});
