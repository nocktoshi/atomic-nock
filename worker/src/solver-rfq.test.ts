import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { awaitRfq, isSolverOnline, touchHeartbeat } from "./solver-rfq.js";
import { marketEnv, type MarketEnv } from "./testing.js";
import type { SolverInboundEvent } from "./solver-events.js";

/** Event-based RFQ: POST is held in the Market DO until the solver answers over
 *  the queue. No record is written; nothing is polled. */
function fakeEnv(): MarketEnv & { boardRaw: Map<string, unknown>; sent: SolverInboundEvent[] } {
  const env = marketEnv();
  const sent: SolverInboundEvent[] = [];
  return Object.assign(env, {
    boardRaw: env.raw,
    sent,
    SOLVER_IN: { send: async (e: SolverInboundEvent) => { sent.push(e); } },
  });
}

describe("solver-rfq (event-based, Durable Object board)", () => {
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
  });

  it("awaitRfq returns offline (no hold, no enqueue) when the solver is down", async () => {
    const rfq = await awaitRfq(env, { side: "buy", amountIn: "10" }, 8000);
    expect(rfq.status).toBe("offline");
    expect(env.sent).toHaveLength(0);
  });

  it("awaitRfq rejects an invalid amount", async () => {
    await expect(awaitRfq(env, { side: "buy", amountIn: "-1" }, 8000)).rejects.toThrow(/amountIn/);
  });

  it("awaitRfq enqueues rfq.created and resolves with the solver's quote", async () => {
    vi.useRealTimers();
    await touchHeartbeat(env, "SOLVER");
    const pending = awaitRfq(env, { side: "buy", amountIn: "10" }, 8000);
    await new Promise((r) => setTimeout(r, 20)); // let online-check + enqueue land
    expect(env.sent).toHaveLength(1);
    const created = env.sent[0] as Extract<SolverInboundEvent, { type: "rfq.created" }>;
    expect(created.type).toBe("rfq.created");
    env.market.resolveRfqResponse(created.rfqId, {
      status: "ready",
      amountOut: "100",
      pricePerNock: 0.1,
      maxAmountIn: "250",
    });
    const q = await pending;
    expect(q.status).toBe("ready");
    expect(q.amountOut).toBe("100");
    expect(q.rfqId).toBe(created.rfqId);
  });

  it("held RFQ expires after holdMs when the solver never answers", async () => {
    const pending = env.market.awaitRfqResponse("rid-late", "sell", "5", 8000);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe("expired");
  });

  it("returns busy once the waiter cap is reached", async () => {
    // Fill the cap with un-resolved waiters (RFQ_MAX_WAITERS = 200).
    for (let i = 0; i < 200; i++) void env.market.awaitRfqResponse(`rid-${i}`, "buy", "1", 8000);
    const q = await env.market.awaitRfqResponse("rid-over", "buy", "1", 8000);
    expect(q.status).toBe("busy");
  });

  it("treats solver online within the heartbeat window", async () => {
    await touchHeartbeat(env, "SOLVER");
    vi.advanceTimersByTime(20_000);
    expect(await isSolverOnline(env)).toBe(true);
  });

  it("treats solver offline once the heartbeat is stale", async () => {
    await touchHeartbeat(env, "SOLVER");
    vi.advanceTimersByTime(91_000);
    expect(await isSolverOnline(env)).toBe(false);
  });
});
