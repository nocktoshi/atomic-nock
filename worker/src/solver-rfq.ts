/**
 * Solver RFQ — event-based. The UI POSTs a sized request; the worker enqueues
 * `rfq.created`, then holds the POST open in the Market DO until the solver
 * answers over the `solver-out` queue (or it times out). No RFQ record is
 * written and nothing is polled. Sensitive pricing params never leave the solver.
 */
import { SwapError, type Env } from "./swaps.js";
import type { SolverRfqResponse } from "../../src/market/solver-rfq.js";
import { withMarket } from "./market-client.js";
import { rfqCreated } from "./solver-events.js";

export { HEARTBEAT_MAX_AGE_MS } from "./market.js";

function isPositiveDecimal(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(v) && parseFloat(v) > 0;
}

export async function isSolverOnline(env: Env): Promise<boolean> {
  return withMarket(env, (stub) => stub.online());
}

export async function touchHeartbeat(env: Env, pkh: string): Promise<void> {
  await withMarket(env, (stub) => stub.touchHeartbeat(pkh));
}

/**
 * Validate, then hold the request open in the Market DO until the solver answers
 * over the queue (or `holdMs` elapses). The DO parks an in-memory waiter that the
 * `solver-out` consumer wakes via `resolveRfqResponse`.
 */
export async function awaitRfq(
  env: Env,
  body: { side?: unknown; amountIn?: unknown },
  holdMs: number
): Promise<SolverRfqResponse> {
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!side) throw new SwapError(400, "side must be buy or sell");
  if (!isPositiveDecimal(body.amountIn)) throw new SwapError(400, "amountIn must be a positive decimal");
  const amountIn = body.amountIn as string;
  const rfqId = crypto.randomUUID();
  if (!(await isSolverOnline(env))) {
    return { rfqId, side, amountIn, status: "offline", expiresAt: Date.now(), reason: "solver offline (try an OTC order)" };
  }
  // Enqueue the work, then park the request in the DO. The queue round-trip
  // (≥ the solver's pull idle) means the solver can't answer before the waiter
  // is registered, so no wakeup is lost.
  if (env.SOLVER_IN) {
    try {
      await env.SOLVER_IN.send(rfqCreated(rfqId, side, amountIn));
    } catch {
      return { rfqId, side, amountIn, status: "expired", expiresAt: Date.now(), reason: "could not reach the solver queue" };
    }
  }
  return withMarket(env, (stub) => stub.awaitRfqResponse(rfqId, side, amountIn, holdMs));
}
