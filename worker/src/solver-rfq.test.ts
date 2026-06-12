import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Env } from "./swaps.js";
import {
  createRfq,
  getRfq,
  isSolverOnline,
  listPendingRfqs,
  respondRfq,
  touchHeartbeat,
} from "./solver-rfq.js";
import { RfqBoard, type BoardStorage } from "./rfq-board.js";

/** Map-backed BoardStorage — the DO's whole storage contract, no miniflare. */
function fakeBoardStorage(): BoardStorage & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    async get<T>(key: string) {
      return raw.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      raw.set(key, value);
    },
    async delete(key: string) {
      return raw.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of raw) if (k.startsWith(prefix)) out.set(k, v as T);
      return out;
    },
  };
}

/** Env whose RFQ_DO namespace routes straight into a real RfqBoard instance. */
function fakeEnv(): Env & { boardRaw: Map<string, unknown> } {
  const storage = fakeBoardStorage();
  const boardInstance = new RfqBoard({ storage });
  const stub = { fetch: (url: string, init?: RequestInit) => boardInstance.fetch(new Request(url, init)) };
  const RFQ_DO = {
    idFromName: (_: string) => "board-id",
    get: (_: unknown) => stub,
  };
  return { RFQ_DO, boardRaw: storage.raw } as unknown as Env & { boardRaw: Map<string, unknown> };
}

describe("solver-rfq (Durable Object board)", () => {
  let env: ReturnType<typeof fakeEnv>;

  beforeEach(() => {
    env = fakeEnv();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports offline when no heartbeat", async () => {
    expect(await isSolverOnline(env)).toBe(false);
    const rfq = await createRfq(env, { side: "buy", amountIn: "10" });
    expect(rfq.status).toBe("offline");
  });

  it("creates pending RFQ when solver is online", async () => {
    await touchHeartbeat(env, "SOLVER");
    const rfq = await createRfq(env, { side: "buy", amountIn: "25.5" });
    expect(rfq.status).toBe("pending");
    expect(rfq.rfqId).toMatch(/^[0-9a-f]{32}$/);
    expect(rfq.amountIn).toBe("25.5");
    const pending = await listPendingRfqs(env);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(rfq.rfqId);
  });

  it("a fresh RFQ is visible to the pending poll IMMEDIATELY (the KV-list lag bug)", async () => {
    await touchHeartbeat(env, "SOLVER");
    const a = await createRfq(env, { side: "buy", amountIn: "1" });
    const b = await createRfq(env, { side: "sell", amountIn: "2" });
    const pending = await listPendingRfqs(env);
    expect(pending.map((r) => r.id)).toEqual([a.rfqId, b.rfqId]); // ordered, instant
  });

  it("responds to RFQ with public fields only", async () => {
    await touchHeartbeat(env, "SOLVER");
    const created = await createRfq(env, { side: "sell", amountIn: "100" });
    const answered = await respondRfq(env, created.rfqId, "SOLVER", {
      status: "ready",
      amountOut: "450.25",
      pricePerNock: 4.5025,
      maxAmountIn: "200",
    });
    expect(answered.status).toBe("ready");
    expect(answered.amountOut).toBe("450.25");
    expect(answered.pricePerNock).toBe(4.5025);
    expect(answered.maxAmountIn).toBe("200");
    expect(await listPendingRfqs(env)).toHaveLength(0);
    const fetched = await getRfq(env, created.rfqId);
    expect(fetched?.status).toBe("ready");
  });

  it("keeps pending RFQ pending while awaiting solver (no mid-poll offline flip)", async () => {
    await touchHeartbeat(env, "SOLVER");
    const created = await createRfq(env, { side: "buy", amountIn: "10" });
    env.boardRaw.delete("heartbeat");
    const fetched = await getRfq(env, created.rfqId);
    expect(fetched?.status).toBe("pending");
  });

  it("treats solver online within heartbeat window (survives 20s poll interval)", async () => {
    await touchHeartbeat(env, "SOLVER");
    vi.advanceTimersByTime(20_000);
    expect(await isSolverOnline(env)).toBe(true);
  });

  it("treats solver offline once heartbeat is stale", async () => {
    await touchHeartbeat(env, "SOLVER");
    vi.advanceTimersByTime(56_000);
    expect(await isSolverOnline(env)).toBe(false);
  });

  it("rejects invalid amount", async () => {
    await touchHeartbeat(env, "SOLVER");
    await expect(createRfq(env, { side: "buy", amountIn: "-1" })).rejects.toThrow(/amountIn/);
  });

  it("refuses to answer an already-answered RFQ", async () => {
    await touchHeartbeat(env, "SOLVER");
    const created = await createRfq(env, { side: "buy", amountIn: "10" });
    await respondRfq(env, created.rfqId, "SOLVER", { status: "rejected", reason: "max 5" });
    await expect(
      respondRfq(env, created.rfqId, "SOLVER", { status: "ready", amountOut: "1" })
    ).rejects.toThrow(/already answered/);
  });

  it("expires an unanswered RFQ after its TTL", async () => {
    await touchHeartbeat(env, "SOLVER");
    const created = await createRfq(env, { side: "buy", amountIn: "10" });
    vi.advanceTimersByTime(56_000);
    const fetched = await getRfq(env, created.rfqId);
    expect(fetched?.status).toBe("expired");
    await touchHeartbeat(env, "SOLVER");
    expect(await listPendingRfqs(env)).toHaveLength(0);
  });
});
