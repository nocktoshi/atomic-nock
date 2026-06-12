/**
 * Solver RFQ queue — UI posts sized quote requests; the solver (on another
 * host) polls pending, prices locally, and writes a short-lived response.
 * Sensitive pricing params never leave the solver.
 *
 * Backed by the Market Durable Object (RPC), not KV: KV `list()` is eventually
 * consistent (new keys can lag ~60s), which left fresh RFQs invisible to the
 * solver's pending poll. The DO gives strict read-your-writes for all parties.
 */
import { SwapError, type Env } from "./swaps.js";
import type { SolverRfqResponse } from "../../src/market/solver-rfq.js";
import type { BoardRfqRecord } from "./market.js";
import { withMarket } from "./market-client.js";

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

export async function createRfq(
  env: Env,
  body: { side?: unknown; amountIn?: unknown }
): Promise<SolverRfqResponse> {
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!side) throw new SwapError(400, "side must be buy or sell");
  if (!isPositiveDecimal(body.amountIn)) throw new SwapError(400, "amountIn must be a positive decimal");

  const rec = await withMarket(env, (stub) => stub.createRfqRecord(side, body.amountIn as string));
  if (!rec) {
    return {
      rfqId: "",
      side,
      status: "offline",
      expiresAt: Date.now(),
      reason: "solver offline (try an OTC order)",
    };
  }
  return toPublic(rec);
}

export async function getRfq(env: Env, id: string): Promise<SolverRfqResponse | null> {
  const rec = await withMarket(env, (stub) => stub.getRfqRecord(id));
  if (!rec) return null;
  return toPublic(rec);
}

export async function listPendingRfqs(env: Env): Promise<BoardRfqRecord[]> {
  return withMarket(env, (stub) => stub.listPendingRfqs());
}

export async function respondRfq(
  env: Env,
  id: string,
  pkh: string,
  body: {
    status: "ready" | "rejected";
    amountOut?: string;
    pricePerNock?: number;
    maxAmountIn?: string;
    reason?: string;
  }
): Promise<SolverRfqResponse> {
  const rec = await withMarket(env, (stub) => stub.respondRfq(id, pkh, body));
  return toPublic(rec);
}

function toPublic(rec: BoardRfqRecord): SolverRfqResponse {
  return {
    rfqId: rec.id,
    side: rec.side,
    status: rec.status,
    amountIn: rec.amountIn,
    amountOut: rec.amountOut,
    pricePerNock: rec.pricePerNock,
    maxAmountIn: rec.maxAmountIn,
    reason: rec.reason,
    expiresAt: rec.expiresAt,
  };
}

export type { BoardRfqRecord as RfqRecord };