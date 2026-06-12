/**
 * Solver RFQ queue — UI posts sized quote requests; the solver (on another
 * host) polls pending, prices locally, and writes a short-lived response.
 * Sensitive pricing params never leave the solver.
 */
import { SwapError, type Env } from "./swaps.js";
import type { RfqSide, RfqStatus, SolverRfqResponse } from "../../src/market/solver-rfq.js";

export const HEARTBEAT_KEY = "solver:heartbeat";
const RFQ_PREFIX = "rfq:";
const PENDING_IDX = "rfq:pending:";

/** Cloudflare KV minimum expiration_ttl (seconds). */
const KV_MIN_TTL_SEC = 60;
/** Solver must heartbeat within this window to count as online. Must exceed
 *  POLL_MS + worst-case tick duration (oracle, inventory, in-flight swaps) —
 *  e.g. POLL_MS=20s needs this well above 20s. Capped just under KV TTL. */
export const HEARTBEAT_MAX_AGE_MS = (KV_MIN_TTL_SEC - 5) * 1000;
/** Logical expiry — must exceed solver POLL_MS + worst-case tick duration so a
 *  sized request isn't gone before the bot's next pass. KV record TTL stays 60s. */
const RFQ_LOGIC_TTL_SEC = 55;

interface RfqRecord {
  id: string;
  side: RfqSide;
  token: "USDC";
  amountIn: string;
  createdAt: number;
  expiresAt: number;
  status: RfqStatus;
  amountOut?: string;
  pricePerNock?: number;
  maxAmountIn?: string;
  reason?: string;
  respondedAt?: number;
  solverPkh?: string;
}

function rfqKey(id: string): string {
  return `${RFQ_PREFIX}${id}`;
}

function isPositiveDecimal(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(v) && parseFloat(v) > 0;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isSolverOnline(env: Env): Promise<boolean> {
  const raw = await env.SWAPS.get(HEARTBEAT_KEY);
  if (!raw) return false;
  try {
    const { ts } = JSON.parse(raw) as { ts?: number };
    return typeof ts === "number" && Date.now() - ts < HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function touchHeartbeat(env: Env, pkh: string): Promise<void> {
  await env.SWAPS.put(HEARTBEAT_KEY, JSON.stringify({ pkh, ts: Date.now() }), {
    expirationTtl: KV_MIN_TTL_SEC,
  });
}

export async function createRfq(
  env: Env,
  body: { side?: unknown; amountIn?: unknown }
): Promise<SolverRfqResponse> {
  if (!(await isSolverOnline(env))) {
    return {
      rfqId: "",
      side: body.side === "sell" ? "sell" : "buy",
      status: "offline",
      expiresAt: Date.now(),
      reason: "solver offline (try an OTC order)",
    };
  }
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!side) throw new SwapError(400, "side must be buy or sell");
  if (!isPositiveDecimal(body.amountIn)) throw new SwapError(400, "amountIn must be a positive decimal");

  const id = randomId();
  const now = Date.now();
  const rec: RfqRecord = {
    id,
    side,
    token: "USDC",
    amountIn: body.amountIn,
    createdAt: now,
    expiresAt: now + RFQ_LOGIC_TTL_SEC * 1000,
    status: "pending",
  };
  await env.SWAPS.put(rfqKey(id), JSON.stringify(rec), { expirationTtl: KV_MIN_TTL_SEC });
  await env.SWAPS.put(PENDING_IDX + id, id, { expirationTtl: KV_MIN_TTL_SEC });
  return toPublic(rec);
}

export async function getRfq(env: Env, id: string): Promise<SolverRfqResponse | null> {
  const raw = await env.SWAPS.get(rfqKey(id));
  if (!raw) return null;
  const rec = JSON.parse(raw) as RfqRecord;
  if (rec.status === "pending" && Date.now() > rec.expiresAt) {
    rec.status = "expired";
  }
  return toPublic(rec);
}

export async function listPendingRfqs(env: Env, limit = 20): Promise<RfqRecord[]> {
  const page = await env.SWAPS.list({ prefix: PENDING_IDX, limit });
  const out: RfqRecord[] = [];
  for (const k of page.keys) {
    const id = k.name.slice(PENDING_IDX.length);
    const raw = await env.SWAPS.get(rfqKey(id));
    if (!raw) {
      await env.SWAPS.delete(k.name).catch(() => {});
      continue;
    }
    const rec = JSON.parse(raw) as RfqRecord;
    if (rec.status !== "pending" || Date.now() > rec.expiresAt) {
      await env.SWAPS.delete(k.name).catch(() => {});
      continue;
    }
    out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
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
  const raw = await env.SWAPS.get(rfqKey(id));
  if (!raw) throw new SwapError(404, "rfq not found");
  const rec = JSON.parse(raw) as RfqRecord;
  if (rec.status !== "pending") throw new SwapError(409, "rfq already answered");
  if (Date.now() > rec.expiresAt) throw new SwapError(410, "rfq expired");

  rec.status = body.status;
  rec.respondedAt = Date.now();
  rec.solverPkh = pkh;
  if (body.amountOut != null) rec.amountOut = body.amountOut;
  if (body.pricePerNock != null) rec.pricePerNock = body.pricePerNock;
  if (body.maxAmountIn != null) rec.maxAmountIn = body.maxAmountIn;
  if (body.reason != null) rec.reason = body.reason;

  await env.SWAPS.put(rfqKey(id), JSON.stringify(rec), { expirationTtl: KV_MIN_TTL_SEC });
  await env.SWAPS.delete(PENDING_IDX + id);
  return toPublic(rec);
}

function toPublic(rec: RfqRecord): SolverRfqResponse {
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

export type { RfqRecord };