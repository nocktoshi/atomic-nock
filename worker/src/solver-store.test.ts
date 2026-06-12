import { describe, it, expect } from "vitest";
import type { Env } from "./swaps.js";
import {
  appendPnl,
  listPnl,
  listTrackedSwaps,
  loadTrackedSwap,
  openExposureUsd,
  patchTrackedSwap,
  pnlSummary,
  putSwapSecret,
  upsertTrackedSwap,
} from "./solver-store.js";
import type { TrackedSwap } from "../../src/solver-state.js";

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

const PKH = "SOLVER_PKH";
const base: TrackedSwap = {
  hEvm: "0xABC",
  role: "seller",
  phase: "filling",
  quoteUsd: 100,
  nockNicks: "65536",
  createdAt: 1,
  updatedAt: 1,
  done: false,
};

describe("solver-store", () => {
  it("upserts and loads a tracked swap", async () => {
    const env = fakeEnv();
    await upsertTrackedSwap(env, PKH, base);
    const got = await loadTrackedSwap(env, PKH, "0xabc");
    expect(got?.phase).toBe("filling");
    expect(got?.updatedAt).toBeGreaterThan(1);
  });

  it("lists all swaps for a pkh", async () => {
    const env = fakeEnv();
    await upsertTrackedSwap(env, PKH, base);
    await upsertTrackedSwap(env, PKH, { ...base, hEvm: "0xdef" });
    await upsertTrackedSwap(env, "OTHER", base);
    const swaps = await listTrackedSwaps(env, PKH);
    expect(swaps.map((s) => s.hEvm.toLowerCase()).sort()).toEqual(["0xabc", "0xdef"]);
  });

  it("patches whitelisted fields", async () => {
    const env = fakeEnv();
    await upsertTrackedSwap(env, PKH, base);
    const patched = await patchTrackedSwap(env, PKH, "0xabc", {
      phase: "locked-nock",
      lockSeenHeight: 42,
    });
    expect(patched.phase).toBe("locked-nock");
    expect(patched.lockSeenHeight).toBe(42);
    expect(patched.role).toBe("seller");
  });

  it("putSwapSecret requires an existing swap", async () => {
    const env = fakeEnv();
    await expect(putSwapSecret(env, PKH, "0xabc", "aabb")).rejects.toMatchObject({ status: 404 });
    await upsertTrackedSwap(env, PKH, base);
    const withSecret = await putSwapSecret(env, PKH, "0xabc", "aabbcc");
    expect(withSecret.secretHex).toBe("aabbcc");
  });

  it("openExposureUsd ignores done swaps", () => {
    expect(
      openExposureUsd([
        { ...base, done: false, quoteUsd: 50 },
        { ...base, hEvm: "0x2", done: true, quoteUsd: 200 },
      ])
    ).toBe(50);
  });

  it("appends pnl and summarizes", async () => {
    const env = fakeEnv();
    await appendPnl(env, PKH, { hEvm: "0x1", ts: 1, nockDelta: 1, usdDelta: 2, note: "a" });
    await appendPnl(env, PKH, { hEvm: "0x2", ts: 2, nockDelta: -0.5, usdDelta: 3, note: "b" });
    const entries = await listPnl(env, PKH);
    expect(entries).toHaveLength(2);
    expect(pnlSummary(entries)).toEqual({ nock: 0.5, usd: 5, count: 2 });
  });
});