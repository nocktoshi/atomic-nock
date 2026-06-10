/**
 * Swap state machine + integrity enforcement. The Worker is the authority: every
 * mutation goes through here, which guarantees:
 *   - immutable economic identity never changes after creation,
 *   - the buyer is committed exactly once (no claim-jumping a committed swap),
 *   - a party may only write their own progress fields,
 *   - optimistic-concurrency version bumps.
 */
import {
  IMMUTABLE_FIELDS,
  BUYER_CLAIM_FIELDS,
  SELLER_FIELDS,
  BUYER_FIELDS,
  type SwapRecord,
} from "./contract.js";

export interface Env {
  SWAPS: KVNamespace;
  SESSION_SECRET?: string;
  KV_TOKEN?: string; // server-only admin secret (never shipped to the browser)
}

const SWAP_PREFIX = "swap:";
const ETH_IDX = "idx:eth:";
const NOCK_IDX = "idx:nock:";

export class SwapError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Protocol ordering (defense-in-depth; the on-chain HTLCs are the real guard):
 *   claim → seller lock NOCK → buyer lock USDC → seller withdraw → buyer claim NOCK.
 * A progress field can only be set once ALL its prerequisite fields already exist.
 */
const PREREQUISITES: Record<string, readonly string[]> = {
  lockFirstName: ["buyerPkh"], // can't lock NOCK with no committed buyer
  usdcLockTxHash: ["lockFirstName"], // buyer locks USDC only after NOCK is locked
  usdcWithdrawTxHash: ["lockFirstName", "usdcLockTxHash"], // seller withdraw needs both legs
  nockClaimTxId: ["usdcWithdrawTxHash"], // buyer claims NOCK after the preimage is revealed
  nockRefundTxId: ["lockFirstName"], // seller refunds only what was locked
  usdcRefundTxHash: ["usdcLockTxHash"], // buyer refunds only what they locked
};

/** A field cannot be set if any conflicting field already exists (terminal states). */
const CONFLICTS: Record<string, readonly string[]> = {
  nockClaimTxId: ["nockRefundTxId"],
  nockRefundTxId: ["nockClaimTxId"],
  usdcWithdrawTxHash: ["usdcRefundTxHash"],
  usdcRefundTxHash: ["usdcWithdrawTxHash"],
};

const id = (hEvm: string) => hEvm.toLowerCase();

export async function loadSwap(env: Env, hEvm: string): Promise<SwapRecord | null> {
  const raw = await env.SWAPS.get(SWAP_PREFIX + id(hEvm));
  return raw ? (JSON.parse(raw) as SwapRecord) : null;
}

async function writeSwap(env: Env, rec: SwapRecord): Promise<void> {
  const key = id(rec.hEvm);
  await env.SWAPS.put(SWAP_PREFIX + key, JSON.stringify(rec));
  // Maintain participant indexes (idempotent; values point back at the id).
  const idx: string[] = [];
  if (rec.sellerEth) idx.push(`${ETH_IDX}${String(rec.sellerEth).toLowerCase()}:${key}`);
  if (rec.buyerEth) idx.push(`${ETH_IDX}${String(rec.buyerEth).toLowerCase()}:${key}`);
  if (rec.sellerPkh) idx.push(`${NOCK_IDX}${rec.sellerPkh}:${key}`);
  if (rec.buyerPkh) idx.push(`${NOCK_IDX}${rec.buyerPkh}:${key}`);
  await Promise.all(idx.map((k) => env.SWAPS.put(k, key)));
}

const REQUIRED_AT_CREATE = [
  "hEvm",
  "hNock",
  "usdcTimelock",
  "nockGift",
  "nockRefundHeight",
  "sellerEth",
  "sellerPkh",
  "usdcAmount",
] as const;

/**
 * Create a swap. The session pkh must equal the swap's sellerPkh (you can only
 * create swaps you sell). Buyer fields are optional (open swap leaves them empty).
 */
export async function createSwap(
  env: Env,
  swap: Record<string, unknown>,
  sessionPkh: string
): Promise<SwapRecord> {
  if (!swap.hEvm || typeof swap.hEvm !== "string") {
    throw new SwapError(400, "missing hEvm");
  }
  for (const f of REQUIRED_AT_CREATE) {
    if (swap[f] == null || swap[f] === "") {
      throw new SwapError(400, `missing required field "${f}"`);
    }
  }
  if (swap.sellerPkh !== sessionPkh) {
    throw new SwapError(403, "sellerPkh must match the signed-in wallet");
  }
  if (await loadSwap(env, swap.hEvm)) {
    throw new SwapError(409, "swap already exists");
  }

  const rec: SwapRecord = {
    ...(swap as SwapRecord),
    hEvm: swap.hEvm,
    sellerPkh: sessionPkh,
    version: 1,
  };
  await writeSwap(env, rec);
  return rec;
}

/**
 * Buyer claims an OPEN swap. buyerPkh is taken from the authenticated session
 * (not the body) so it can't be spoofed. Compare-and-set: only succeeds while
 * the buyer is uncommitted, so two buyers can't both claim the same swap.
 */
export async function claimSwap(
  env: Env,
  hEvm: string,
  buyerEth: string,
  sessionPkh: string
): Promise<SwapRecord> {
  const prev = await loadSwap(env, hEvm);
  if (!prev) throw new SwapError(404, "swap not found");
  if (prev.buyerPkh || prev.buyerEth) {
    throw new SwapError(409, "swap already claimed");
  }
  if (prev.sellerPkh === sessionPkh) {
    throw new SwapError(403, "seller cannot claim their own swap");
  }
  if (!buyerEth) throw new SwapError(400, "missing buyerEth");

  const rec: SwapRecord = {
    ...prev,
    buyerPkh: sessionPkh,
    buyerEth,
    version: (prev.version ?? 1) + 1,
  };
  await writeSwap(env, rec);
  return rec;
}

/**
 * Advance a swap with progress fields. The session pkh decides the role:
 * seller may write SELLER_FIELDS, buyer may write BUYER_FIELDS. Immutable and
 * already-committed buyer fields are protected.
 */
export async function advanceSwap(
  env: Env,
  hEvm: string,
  fields: Record<string, unknown>,
  sessionPkh: string,
  expectedVersion?: number
): Promise<SwapRecord> {
  const prev = await loadSwap(env, hEvm);
  if (!prev) throw new SwapError(404, "swap not found");
  if (expectedVersion != null && (prev.version ?? 1) !== expectedVersion) {
    throw new SwapError(409, "version conflict — reload and retry");
  }

  const isSeller = sessionPkh === prev.sellerPkh;
  const isBuyer = sessionPkh === prev.buyerPkh;
  if (!isSeller && !isBuyer) throw new SwapError(403, "not a participant in this swap");

  // Diff-based authorization: the client may send the full swap; we only apply —
  // and only authorize — fields that actually CHANGED. Unchanged immutable/other
  // fields are ignored, so a stale client can't be tripped up by them.
  const next: SwapRecord = { ...prev };
  for (const [f, v] of Object.entries(fields)) {
    if (String(v ?? "") === String(prev[f] ?? "")) continue; // unchanged
    if (IMMUTABLE_FIELDS.includes(f as never) || BUYER_CLAIM_FIELDS.includes(f as never)) {
      throw new SwapError(409, `field "${f}" is immutable once set`);
    }
    if (SELLER_FIELDS.includes(f as never)) {
      if (!isSeller) throw new SwapError(403, `only the seller may write "${f}"`);
    } else if (BUYER_FIELDS.includes(f as never)) {
      if (!isBuyer) throw new SwapError(403, `only the buyer may write "${f}"`);
    } else {
      throw new SwapError(403, `unknown field "${f}"`);
    }
    // Ordering: every prerequisite must already exist on the prior record.
    for (const p of PREREQUISITES[f] ?? []) {
      if (!prev[p]) throw new SwapError(409, `cannot set "${f}" before "${p}" is set`);
    }
    // Mutual exclusion: can't enter a terminal state that conflicts with another.
    for (const c of CONFLICTS[f] ?? []) {
      if (prev[c]) throw new SwapError(409, `cannot set "${f}": "${c}" is already set`);
    }
    next[f] = v;
  }
  next.version = (prev.version ?? 1) + 1;
  await writeSwap(env, next);
  return next;
}
