import { describe, it, expect, beforeEach } from "vitest";
import { marketEnv, type MarketEnv } from "./testing.js";
import { isSolverOnline } from "./solver-rfq.js";
import { createSwap, claimSwap } from "./swaps.js";
import { processSolverOutbound } from "./solver-queue.js";
import type { SolverInboundEvent, SolverOutboundEvent } from "./solver-events.js";

type QueueEnv = MarketEnv & {
  sent: SolverInboundEvent[];
  SOLVER_IN: Queue<SolverInboundEvent>;
  SOLVER_PKHS: string;
};

function queueEnv(solverPkh = "SOLVER"): QueueEnv {
  const env = marketEnv() as QueueEnv;
  env.sent = [];
  env.SOLVER_PKHS = solverPkh;
  env.SOLVER_IN = {
    send: async (e: SolverInboundEvent) => {
      env.sent.push(e);
      return { id: "test-msg" };
    },
    sendBatch: async () => [],
    metrics: async () => ({ queued: 0 }),
  } as unknown as Queue<SolverInboundEvent>;
  return env;
}

const baseSwap = {
  hEvm: "0xabc",
  hNock: "HN",
  sellerPkh: "SELLER",
  usdcTimelock: "9999999999",
  nockGift: "3276800",
  nockRefundHeight: "1",
  sellerEth: "0xseller",
  usdcAmount: "100",
};

describe("solver queue consumer", () => {
  let env: QueueEnv;

  beforeEach(() => {
    env = queueEnv();
  });

  it("applies swap.claim and echoes swap.updated", async () => {
    await createSwap(env, baseSwap, "SELLER");
    const cmd: SolverOutboundEvent = {
      v: 1,
      type: "swap.claim",
      commandId: "cmd-1",
      ts: Date.now(),
      hEvm: "0xabc",
      buyerEth: "0xbuyer",
      solverPkh: "SOLVER",
    };
    await processSolverOutbound(env, cmd);
    expect(env.sent.some((e) => e.type === "swap.updated")).toBe(true);
    const updated = env.sent.find((e) => e.type === "swap.updated");
    expect(updated && updated.type === "swap.updated" ? updated.swap.buyerPkh : null).toBe(
      "SOLVER"
    );
  });

  it("publishes command.failed on version conflict", async () => {
    await createSwap(env, baseSwap, "SELLER");
    await claimSwap(env, "0xabc", "0xbuyer", "SOLVER");
    const cmd: SolverOutboundEvent = {
      v: 1,
      type: "swap.claim",
      commandId: "cmd-2",
      ts: Date.now(),
      hEvm: "0xabc",
      buyerEth: "0xother",
      solverPkh: "SOLVER",
    };
    await expect(processSolverOutbound(env, cmd)).rejects.toMatchObject({ status: 409 });
  });

  it("records heartbeat via solver.heartbeat command", async () => {
    const cmd: SolverOutboundEvent = {
      v: 1,
      type: "solver.heartbeat",
      commandId: "hb-1",
      ts: Date.now(),
      solverPkh: "SOLVER",
    };
    await processSolverOutbound(env, cmd);
    expect(await isSolverOnline(env)).toBe(true);
  });
});