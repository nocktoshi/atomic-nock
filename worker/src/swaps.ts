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

import type { RateLimiter } from "./ratelimit.js";

export interface Env {
  SWAPS: KVNamespace;
  SESSION_SECRET?: string;
  KV_TOKEN?: string; // server-only admin secret (never shipped to the browser)
  /** Rate limiters (wrangler.toml [[ratelimits]]); optional so dev/tests skip them. */
  RL_READ?: RateLimiter;
  RL_WRITE?: RateLimiter;
  RL_AUTH?: RateLimiter;
  /** Telegram notifications (secrets via `wrangler secret put`). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Bot username (var, not secret) for the t.me deep link, e.g. "AtomicNockBot". */
  TELEGRAM_BOT_NAME?: string;
  /** Web Push VAPID keys (public+subject are vars; private via `wrangler secret put`). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Email via Resend (key is a secret; from-address is a var). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Site base URL for notification deep links (default https://atomicnock.com). */
  APP_URL?: string;
}

const SWAP_PREFIX = "swap:";
const ETH_IDX = "idx:eth:";
const NOCK_IDX = "idx:nock:";
/** Marketplace index: one key per OPEN (buyer-less) swap; removed on claim/cancel. */
const OPEN_IDX = "idx:open:";

/** Hide open swaps whose quote-leg refund opens sooner than this — too stale to fill. */
const MIN_OPEN_WINDOW_SEC = 3600;

/** Quote tokens the Base leg may pay. Absent on a record = USDC (pre-multi-asset). */
const ALLOWED_TOKENS = ["USDC", "WNOCK"] as const;

/**
 * Swaps expire 30 days after their LAST write (every claim/advance refreshes the
 * TTL). The full swap lifecycle is bounded to ~30h, so an active swap can never
 * expire mid-flight; finished ones age out of KV. Funds are never at risk from
 * expiry — the preimage lives client-side and on-chain state is authoritative.
 */
const SWAP_TTL_SECONDS = 30 * 24 * 3600;

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
  const opts = { expirationTtl: SWAP_TTL_SECONDS };
  await env.SWAPS.put(SWAP_PREFIX + key, JSON.stringify(rec), opts);
  // Maintain participant indexes (idempotent; values point back at the id).
  // Same TTL as the record so index keys can't outlive (or dangle past) it.
  const idx: string[] = [];
  if (rec.sellerEth) idx.push(`${ETH_IDX}${String(rec.sellerEth).toLowerCase()}:${key}`);
  if (rec.buyerEth) idx.push(`${ETH_IDX}${String(rec.buyerEth).toLowerCase()}:${key}`);
  if (rec.sellerPkh) idx.push(`${NOCK_IDX}${rec.sellerPkh}:${key}`);
  if (rec.buyerPkh) idx.push(`${NOCK_IDX}${rec.buyerPkh}:${key}`);
  await Promise.all(idx.map((k) => env.SWAPS.put(k, key, opts)));
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
  if (
    swap.token != null &&
    !ALLOWED_TOKENS.includes(swap.token as (typeof ALLOWED_TOKENS)[number])
  ) {
    throw new SwapError(400, `unknown token "${String(swap.token)}"`);
  }
  if (await loadSwap(env, swap.hEvm)) {
    throw new SwapError(409, "swap already exists");
  }

  const rec: SwapRecord = {
    ...(swap as SwapRecord),
    hEvm: swap.hEvm,
    sellerPkh: sessionPkh,
    createdAt: Math.floor(Date.now() / 1000), // server-stamped; client sort key
    version: 1,
  };
  await writeSwap(env, rec);
  // An open (buyer-less) swap is listable in the marketplace until claimed.
  if (!rec.buyerPkh) {
    await env.SWAPS.put(OPEN_IDX + id(rec.hEvm), id(rec.hEvm), {
      expirationTtl: SWAP_TTL_SECONDS,
    });
  }
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
  await env.SWAPS.delete(OPEN_IDX + id(hEvm)); // claimed → off the marketplace
  return rec;
}

/**
 * Seller cancels an OPEN swap. Only allowed while nothing exists on-chain:
 * no committed buyer and no NOCK locked. Deletes the record and every index.
 */
export async function cancelSwap(
  env: Env,
  hEvm: string,
  sessionPkh: string
): Promise<void> {
  const prev = await loadSwap(env, hEvm);
  if (!prev) throw new SwapError(404, "swap not found");
  if (prev.sellerPkh !== sessionPkh) {
    throw new SwapError(403, "only the seller may cancel a swap");
  }
  if (prev.buyerPkh || prev.buyerEth) {
    throw new SwapError(409, "swap already claimed — it can no longer be cancelled");
  }
  if (prev.lockFirstName || prev.nockLockTxId) {
    throw new SwapError(409, "NOCK already locked — refund it instead of cancelling");
  }
  const key = id(hEvm);
  const keys = [SWAP_PREFIX + key, OPEN_IDX + key];
  if (prev.sellerEth) keys.push(`${ETH_IDX}${String(prev.sellerEth).toLowerCase()}:${key}`);
  if (prev.sellerPkh) keys.push(`${NOCK_IDX}${prev.sellerPkh}:${key}`);
  await Promise.all(keys.map((k) => env.SWAPS.delete(k)));
}

/**
 * Marketplace listing: open swaps, newest first. Filters records that were
 * claimed/expired out from under their index entry (and lazily deletes those
 * index keys). Public — swap metadata is already readable via GET /swap/:id.
 */
export async function listOpenSwaps(
  env: Env,
  cursor?: string,
  limit = 50
): Promise<{ swaps: SwapRecord[]; cursor?: string; complete: boolean }> {
  const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 50);
  const page = await env.SWAPS.list({ prefix: OPEN_IDX, cursor, limit: capped });
  const now = Math.floor(Date.now() / 1000);

  const out: SwapRecord[] = [];
  const stale: string[] = [];
  await Promise.all(
    page.keys.map(async (k) => {
      const hEvm = k.name.slice(OPEN_IDX.length);
      const rec = await loadSwap(env, hEvm);
      const timelock = Number(rec?.usdcTimelock ?? 0);
      if (!rec || rec.buyerPkh || timelock <= now + MIN_OPEN_WINDOW_SEC) {
        stale.push(k.name);
        return;
      }
      out.push(rec);
    })
  );
  // Lazy cleanup — never block the response on it.
  await Promise.all(stale.map((k) => env.SWAPS.delete(k).catch(() => {})));

  out.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  return {
    swaps: out,
    cursor: page.list_complete ? undefined : page.cursor,
    complete: page.list_complete,
  };
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
