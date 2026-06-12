import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createRfq,
  getRfq,
  isSolverOnline,
  listPendingRfqs,
  respondRfq,
  touchHeartbeat,
} from "./solver-rfq.js";
import { marketEnv, type MarketEnv } from "./testing.js";

/** The RFQ board now lives inside the Market DO; same routes, same semantics. */
function fakeEnv(): MarketEnv & { boardRaw: Map<string, unknown> } {
  const env = marketEnv();
  return Object.assign(env, { boardRaw: env.raw });
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
    expect(pending.map((r) => r.id)).toEqual([b.rfqId, a.rfqId]); // ordered, instant
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
