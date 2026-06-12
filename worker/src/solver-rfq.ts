/**
 * Solver RFQ queue — UI posts sized quote requests; the solver (on another
 * host) polls pending, prices locally, and writes a short-lived response.
 * Sensitive pricing params never leave the solver.
 *
 * Backed by the RfqBoard DURABLE OBJECT, not KV: KV `list()` is eventually
 * consistent (new keys can lag ~60s), which left fresh RFQs invisible to the
 * solver's pending poll. The DO gives strict read-your-writes for all parties.
 * This module keeps the original function surface and maps board errors to
 * SwapError, so routes and tests are unchanged.
 */
import { SwapError, type Env } from "./swaps.js";
import type { SolverRfqResponse } from "../../src/market/solver-rfq.js";
import type { BoardRfqRecord } from "./market.js";
import { marketStub } from "./market-client.js";

export { HEARTBEAT_MAX_AGE_MS } from "./market.js";

function isPositiveDecimal(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(v) && parseFloat(v) > 0;
}

async function call<T>(env: Env, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await marketStub(env).fetch(`https://market${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

export async function isSolverOnline(env: Env): Promise<boolean> {
  const { body } = await call<{ online?: boolean }>(env, "/status");
  return !!body.online;
}

export async function touchHeartbeat(env: Env, pkh: string): Promise<void> {
  await call(env, "/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pkh }),
  });
}

export async function createRfq(
  env: Env,
  body: { side?: unknown; amountIn?: unknown }
): Promise<SolverRfqResponse> {
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!side) throw new SwapError(400, "side must be buy or sell");
  if (!isPositiveDecimal(body.amountIn)) throw new SwapError(400, "amountIn must be a positive decimal");

  const { status, body: rec } = await call<BoardRfqRecord & { error?: string }>(env, "/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side, amountIn: body.amountIn }),
  });
  if (status === 503) {
    return {
      rfqId: "",
      side,
      status: "offline",
      expiresAt: Date.now(),
      reason: "solver offline (try an OTC order)",
    };
  }
  if (status !== 200) throw new SwapError(500, rec.error ?? "rfq create failed");
  return toPublic(rec);
}

export async function getRfq(env: Env, id: string): Promise<SolverRfqResponse | null> {
  const { status, body } = await call<BoardRfqRecord & { error?: string }>(
    env,
    `/get?id=${encodeURIComponent(id)}`
  );
  if (status === 404) return null;
  if (status !== 200) throw new SwapError(500, body.error ?? "rfq read failed");
  return toPublic(body);
}

export async function listPendingRfqs(env: Env): Promise<BoardRfqRecord[]> {
  const { status, body } = await call<{ rfqs?: BoardRfqRecord[]; error?: string }>(env, "/pending");
  if (status !== 200) throw new SwapError(500, body.error ?? "rfq list failed");
  return body.rfqs?.sort((a,b)=>a.createdAt-b.createdAt) ?? [];
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
  const { status, body: rec } = await call<BoardRfqRecord & { error?: string }>(env, "/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, pkh, ...body }),
  });
  if (status === 404) throw new SwapError(404, "rfq not found");
  if (status === 409) throw new SwapError(409, "rfq already answered");
  if (status === 410) throw new SwapError(410, "rfq expired");
  if (status !== 200) throw new SwapError(500, rec.error ?? "rfq respond failed");
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
