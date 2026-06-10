import { describe, it, expect } from "vitest";
import {
  createSwap,
  claimSwap,
  advanceSwap,
  cancelSwap,
  listOpenSwaps,
  type Env,
} from "./swaps.js";
import { enforceRate } from "./ratelimit.js";

/** In-memory KV mock for the Worker's Env; records the options of every put. */
function fakeEnv(): Env & { putOpts: Map<string, unknown>; store: Map<string, string> } {
  const store = new Map<string, string>();
  const putOpts = new Map<string, unknown>();
  const SWAPS = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: unknown) => {
      store.set(k, v);
      putOpts.set(k, opts);
    },
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
  return { SWAPS, putOpts, store } as unknown as Env & {
    putOpts: Map<string, unknown>;
    store: Map<string, string>;
  };
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

describe("KV housekeeping", () => {
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

  it("writes the record and every index with a TTL", async () => {
    const env = await seedClaimed();
    expect(env.putOpts.size).toBeGreaterThan(0);
    for (const [key, opts] of env.putOpts) {
      const ttl = (opts as { expirationTtl?: number } | undefined)?.expirationTtl;
      expect(ttl, `missing TTL on put of ${key}`).toBe(30 * 24 * 3600);
    }
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
    expect(env.store.get("swap:0xabc")).toBeUndefined();
    expect([...env.store.keys()].filter((k) => k.includes("0xabc"))).toEqual([]);
  });

  it("only the seller can cancel", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await expect(cancelSwap(env, "0xabc", BUYER)).rejects.toMatchObject({ status: 403 });
  });

  it("cannot cancel once claimed", async () => {
    const env = fakeEnv();
    await createSwap(env, { ...openSwap }, SELLER);
    await claimSwap(env, "0xabc", "0xbuyer", BUYER);
    await expect(cancelSwap(env, "0xabc", SELLER)).rejects.toMatchObject({ status: 409 });
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
    const oldRec = JSON.parse(env.store.get("swap:0xold")!);
    oldRec.createdAt -= 100;
    env.store.set("swap:0xold", JSON.stringify(oldRec));
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
