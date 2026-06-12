/**
 * Market — the SQLite-backed Durable Object that is the system of record for
 * all swap-system coordination state: swaps, bids, the live RFQ queue, solver
 * heartbeat, and solver tracking state + P&L.
 *
 * WHY A DO (and not KV): this data is coordination state. Cloudflare KV is an
 * eventually-consistent cache — `list()` can lag new keys by ~60s (which
 * stranded fresh RFQs), read-after-write across colos is unreliable (which
 * forced client cache band-aids), and there are no transactions (which forced
 * PATCH-shaped writes and left validate-then-write racy). A single DO instance
 * executes requests one at a time over durable SQLite-backed storage, so every
 * mutation here is atomic and every read is read-your-writes for all parties.
 * Bid fills are now genuinely atomic (the KV double-fill race is gone).
 *
 * The class keeps the RfqBoard seam: a minimal `MarketStorage` interface so
 * unit tests run against a Map-backed fake without miniflare. Operations are
 * public RPC methods; the worker calls them via `stub.method()` (see market-do.ts).
 * KV remains ONLY for user-scoped, latency-insensitive data (profiles,
 * telegram links, email codes, push subscriptions).
 */
import {
  IMMUTABLE_FIELDS,
  BUYER_CLAIM_FIELDS,
  SELLER_FIELDS,
  BUYER_FIELDS,
  type SwapRecord,
} from "./contract.js";
import { SwapError } from "./errors.js";
import type { PnlEntry, TrackedSwap, TrackedSwapPatch } from "../../src/solver-state.js";
import type { RfqSide, RfqStatus } from "../../src/market/solver-rfq.js";

// ── Storage seam (Map-backed fake in tests; DO storage in production) ─────────

export interface MarketStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

const SWAP_PREFIX = "swap:";
const OPEN_PREFIX = "open:"; // marketplace index: one key per OPEN (buyer-less) swap
const MINE_PREFIX = "mine:"; // participant index: mine:<pkh>:<hEvm>
const BID_PREFIX = "bid:";
const BID_FILLED_PREFIX = "bidswap:"; // tombstone: filled bid → swap hEvm
const SOLVER_SWAP_PREFIX = "solver:"; // solver:<pkh>:swap:<hEvm>
const RFQ_PREFIX = "rfq:";
const HEARTBEAT_KEY = "heartbeat";

const id = (hEvm: string) => hEvm.toLowerCase();
const mineKey = (pkh: string, hEvm: string) => `${MINE_PREFIX}${pkh}:${id(hEvm)}`;
const solverSwapKey = (pkh: string, hEvm: string) => `${SOLVER_SWAP_PREFIX}${pkh}:swap:${id(hEvm)}`;
const pnlKey = (pkh: string) => `${SOLVER_SWAP_PREFIX}${pkh}:pnl`;

// ── Policy constants (ported verbatim from the KV modules) ────────────────────

/** Hide open swaps whose quote-leg refund opens sooner than this — too stale to fill. */
const MIN_OPEN_WINDOW_SEC = 3600;
const ALLOWED_TOKENS = ["USDC", "WNOCK"] as const;
const MIN_NOCK_NICKS = 50n * 65536n;
/** Records are swept this long after their LAST write (lifecycle is ~30h, so an
 *  active swap can never age out mid-flight; on-chain state stays authoritative). */
const RECORD_MAX_AGE_SEC = 30 * 24 * 3600;

/** Solver must heartbeat within this window to count as online. */
export const HEARTBEAT_MAX_AGE_MS = 55_000;
/** An unanswered RFQ expires after this (covers one slow solver tick). */
const RFQ_TTL_MS = 55_000;
/** Answered records linger briefly so the UI's next poll can read them. */
const ANSWERED_LINGER_MS = 120_000;

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
 * Protocol ordering (defense-in-depth; the on-chain HTLCs are the real guard):
 *   claim → seller lock NOCK → buyer lock USDC → seller withdraw → buyer claim NOCK.
 * A progress field can only be set once ALL its prerequisite fields already exist.
 */
const PREREQUISITES: Record<string, readonly string[]> = {
  lockFirstName: ["buyerPkh"],
  usdcLockTxHash: ["lockFirstName"],
  usdcWithdrawTxHash: ["lockFirstName", "usdcLockTxHash"],
  nockClaimTxId: ["usdcWithdrawTxHash"],
  nockRefundTxId: ["lockFirstName"],
  usdcRefundTxHash: ["usdcLockTxHash"],
};

/** A field cannot be set if any conflicting field already exists (terminal states). */
const CONFLICTS: Record<string, readonly string[]> = {
  nockClaimTxId: ["nockRefundTxId"],
  nockRefundTxId: ["nockClaimTxId"],
  usdcWithdrawTxHash: ["usdcRefundTxHash"],
  usdcRefundTxHash: ["usdcWithdrawTxHash"],
};

// ── Record shapes ─────────────────────────────────────────────────────────────

export interface BidRecord {
  id: string;
  creatorPkh: string;
  creatorEth: string;
  token: (typeof ALLOWED_TOKENS)[number];
  quoteAmount: string;
  nockGift: string;
  createdAt: number;
  version: number;
}

export interface BoardRfqRecord {
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

/** Payload for the one-time KV→DO migration. */
export interface ImportPayload {
  swaps?: SwapRecord[];
  bids?: BidRecord[];
  /** Filled-bid tombstones: bid id → swap hEvm. */
  bidFills?: Record<string, string>;
  /** Solver tracking state, keyed by pkh. */
  solverSwaps?: Record<string, TrackedSwap[]>;
  pnl?: Record<string, PnlEntry[]>;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isPositiveDecimal(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(v) && parseFloat(v) > 0;
}

function isPositiveInt(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,24}$/.test(v) && v !== "0".repeat(v.length);
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── The Durable Object ────────────────────────────────────────────────────────

export class MarketCore {
  private readonly storage: MarketStorage;

  constructor(storage: MarketStorage) {
    this.storage = storage;
  }

  // ── Swaps (state machine moved IN — load→validate→write is atomic here) ────

  async loadSwap(hEvm: string): Promise<SwapRecord | null> {
    return (await this.storage.get<SwapRecord>(SWAP_PREFIX + id(hEvm))) ?? null;
  }

  private async writeSwap(rec: SwapRecord): Promise<void> {
    const key = id(rec.hEvm);
    rec.updatedAt = nowSec();
    await this.storage.put(SWAP_PREFIX + key, rec);
    // Participant index (idempotent; replaces KV's idx:nock keys).
    if (rec.sellerPkh) await this.storage.put(mineKey(String(rec.sellerPkh), key), key);
    if (rec.buyerPkh) await this.storage.put(mineKey(String(rec.buyerPkh), key), key);
  }

  async createSwap(swap: Record<string, unknown>, sessionPkh: string): Promise<SwapRecord> {
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
    if (await this.loadSwap(swap.hEvm)) {
      throw new SwapError(409, "swap already exists");
    }
    if (!/^\d{1,24}$/.test(String(swap.nockGift)) || BigInt(String(swap.nockGift)) < MIN_NOCK_NICKS) {
      throw new SwapError(400, "nockGift must be at least 50 NOCK");
    }

    const rec: SwapRecord = {
      ...(swap as SwapRecord),
      hEvm: swap.hEvm,
      sellerPkh: sessionPkh,
      createdAt: nowSec(), // server-stamped; client sort key
      version: 1,
    };
    await this.writeSwap(rec);
    // An open (buyer-less) swap is listable in the marketplace until claimed.
    if (!rec.buyerPkh) await this.storage.put(OPEN_PREFIX + id(rec.hEvm), id(rec.hEvm));
    return rec;
  }

  /** Buyer claims an OPEN swap. Atomic in the DO: two buyers cannot both win. */
  async claimSwap(hEvm: string, buyerEth: string, sessionPkh: string): Promise<SwapRecord> {
    const prev = await this.loadSwap(hEvm);
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
    await this.writeSwap(rec);
    await this.storage.delete(OPEN_PREFIX + id(hEvm)); // claimed → off the marketplace
    return rec;
  }

  /** Cancel while nothing is on-chain. Either participant may cancel. */
  async cancelSwap(hEvm: string, sessionPkh: string): Promise<void> {
    const prev = await this.loadSwap(hEvm);
    if (!prev) throw new SwapError(404, "swap not found");
    if (prev.sellerPkh !== sessionPkh && prev.buyerPkh !== sessionPkh) {
      throw new SwapError(403, "only a participant may cancel a swap");
    }
    if (prev.lockFirstName || prev.nockLockTxId) {
      throw new SwapError(409, "NOCK already locked — refund it instead of cancelling");
    }
    if (prev.usdcLockTxHash) {
      throw new SwapError(409, "quote token already locked — refund it instead of cancelling");
    }
    const key = id(hEvm);
    await this.storage.delete(SWAP_PREFIX + key);
    await this.storage.delete(OPEN_PREFIX + key);
    if (prev.sellerPkh) await this.storage.delete(mineKey(String(prev.sellerPkh), key));
    if (prev.buyerPkh) await this.storage.delete(mineKey(String(prev.buyerPkh), key));
  }

  /**
   * Advance a swap with progress fields. Diff-based authorization (ported
   * verbatim): only CHANGED fields are applied and authorized, so a stale
   * client can't be tripped up by unchanged immutable fields.
   */
  async advanceSwap(
    hEvm: string,
    fields: Record<string, unknown>,
    sessionPkh: string,
    expectedVersion?: number
  ): Promise<SwapRecord> {
    const prev = await this.loadSwap(hEvm);
    if (!prev) throw new SwapError(404, "swap not found");
    if (expectedVersion != null && (prev.version ?? 1) !== expectedVersion) {
      throw new SwapError(409, "version conflict — reload and retry");
    }

    const isSeller = sessionPkh === prev.sellerPkh;
    const isBuyer = sessionPkh === prev.buyerPkh;
    if (!isSeller && !isBuyer) throw new SwapError(403, "not a participant in this swap");

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
      for (const p of PREREQUISITES[f] ?? []) {
        if (!prev[p]) throw new SwapError(409, `cannot set "${f}" before "${p}" is set`);
      }
      for (const c of CONFLICTS[f] ?? []) {
        if (prev[c]) throw new SwapError(409, `cannot set "${f}": "${c}" is already set`);
      }
      next[f] = v;
    }
    next.version = (prev.version ?? 1) + 1;
    await this.writeSwap(next);
    return next;
  }

  /** Marketplace listing: open swaps, newest first. Prunes stale entries inline. */
  async listOpenSwaps(limit = 50): Promise<SwapRecord[]> {
    const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 50);
    const entries = await this.storage.list<string>({ prefix: OPEN_PREFIX });
    const now = nowSec();
    const out: SwapRecord[] = [];
    for (const key of entries.keys()) {
      const rec = await this.loadSwap(key.slice(OPEN_PREFIX.length));
      const timelock = Number(rec?.usdcTimelock ?? 0);
      if (!rec || rec.buyerPkh || timelock <= now + MIN_OPEN_WINDOW_SEC) {
        await this.storage.delete(key); // stale — consistent delete, no lag
        continue;
      }
      out.push(rec);
    }
    out.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    return out.slice(0, capped);
  }

  /** Every swap a pkh participates in (replaces KV's /list?prefix=idx:nock:…). */
  async listMine(pkh: string): Promise<string[]> {
    const entries = await this.storage.list<string>({ prefix: `${MINE_PREFIX}${pkh}:` });
    return [...entries.values()];
  }

  // ── Bids ────────────────────────────────────────────────────────────────────

  async loadBid(bidId: string): Promise<BidRecord | null> {
    return (await this.storage.get<BidRecord>(BID_PREFIX + bidId.toLowerCase())) ?? null;
  }

  /** A bid, or where it went: open record, `{ filledHEvm }` after a fill, or null. */
  async lookupBid(bidId: string): Promise<BidRecord | { filledHEvm: string } | null> {
    const bid = await this.loadBid(bidId);
    if (bid) return bid;
    const hEvm = await this.storage.get<string>(BID_FILLED_PREFIX + bidId.toLowerCase());
    return hEvm ? { filledHEvm: hEvm } : null;
  }

  async createBid(body: Record<string, unknown>, sessionPkh: string): Promise<BidRecord> {
    if (!ALLOWED_TOKENS.includes(body.token as (typeof ALLOWED_TOKENS)[number])) {
      throw new SwapError(400, `unknown token "${String(body.token)}"`);
    }
    if (!isPositiveDecimal(body.quoteAmount)) {
      throw new SwapError(400, "quoteAmount must be a positive decimal string");
    }
    if (!isPositiveInt(body.nockGift)) {
      throw new SwapError(400, "nockGift must be a positive integer string (nicks)");
    }
    if (BigInt(body.nockGift as string) < MIN_NOCK_NICKS) {
      throw new SwapError(400, "nockGift must be at least 10 NOCK (to cover on-chain fees)");
    }
    if (typeof body.creatorEth !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.creatorEth)) {
      throw new SwapError(400, "creatorEth must be a Base address");
    }

    const rec: BidRecord = {
      id: randomId(),
      creatorPkh: sessionPkh,
      creatorEth: body.creatorEth,
      token: body.token as BidRecord["token"],
      quoteAmount: body.quoteAmount as string,
      nockGift: body.nockGift as string,
      createdAt: nowSec(),
      version: 1,
    };
    await this.storage.put(BID_PREFIX + rec.id, rec);
    return rec;
  }

  async listBids(limit = 50): Promise<BidRecord[]> {
    const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 50);
    const entries = await this.storage.list<BidRecord>({ prefix: BID_PREFIX });
    return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, capped);
  }

  async cancelBid(bidId: string, sessionPkh: string): Promise<void> {
    const bid = await this.loadBid(bidId);
    if (!bid) throw new SwapError(404, "bid not found");
    if (bid.creatorPkh !== sessionPkh) {
      throw new SwapError(403, "only the bid creator may cancel it");
    }
    await this.storage.delete(BID_PREFIX + bidId.toLowerCase());
  }

  /**
   * Fill a bid. Economic identity is FORCED from the bid; the fill consumes the
   * bid ATOMICALLY with the swap creation — the cross-colo double-fill race the
   * KV implementation documented is structurally gone.
   */
  async fillBid(
    bidId: string,
    swap: Record<string, unknown>,
    sessionPkh: string
  ): Promise<{ swap: SwapRecord; bid: BidRecord }> {
    const bid = await this.loadBid(bidId);
    if (!bid) throw new SwapError(404, "bid not found (already filled or cancelled?)");
    if (bid.creatorPkh === sessionPkh) {
      throw new SwapError(403, "you can't fill your own bid");
    }

    const forced: Record<string, unknown> = {
      ...swap,
      buyerPkh: bid.creatorPkh,
      buyerEth: bid.creatorEth,
      token: bid.token,
      usdcAmount: bid.quoteAmount,
      nockGift: bid.nockGift,
    };
    const rec = await this.createSwap(forced, sessionPkh);
    await this.storage.delete(BID_PREFIX + bidId.toLowerCase());
    await this.storage.put(BID_FILLED_PREFIX + bidId.toLowerCase(), String(rec.hEvm).toLowerCase());
    return { swap: rec, bid };
  }

  // ── Feed (always fresh — replaces the KV snapshot + invalidation machinery) ─

  async feed(limit = 50): Promise<{ swaps: SwapRecord[]; bids: BidRecord[]; ts: number }> {
    // Opportunistic aging (~1% of feed reads; replaces the old router hook).
    if (Math.random() < 0.01) await this.sweep();
    const [swaps, bids] = await Promise.all([this.listOpenSwaps(limit), this.listBids(limit)]);
    return { swaps, bids, ts: Date.now() };
  }

  // ── Solver tracking state + P&L (per pkh) ───────────────────────────────────

  async listTrackedSwaps(pkh: string): Promise<TrackedSwap[]> {
    const entries = await this.storage.list<TrackedSwap>({
      prefix: `${SOLVER_SWAP_PREFIX}${pkh}:swap:`,
    });
    return [...entries.values()];
  }

  async loadTrackedSwap(pkh: string, hEvm: string): Promise<TrackedSwap | null> {
    return (await this.storage.get<TrackedSwap>(solverSwapKey(pkh, hEvm))) ?? null;
  }

  async upsertTrackedSwap(pkh: string, swap: TrackedSwap): Promise<TrackedSwap> {
    if (!swap.hEvm) throw new SwapError(400, "missing hEvm");
    const prev = await this.loadTrackedSwap(pkh, swap.hEvm);
    // Never let a full upsert silently drop a persisted secret.
    const next: TrackedSwap = {
      ...swap,
      secretHex: swap.secretHex ?? prev?.secretHex,
      updatedAt: Date.now(),
    };
    await this.storage.put(solverSwapKey(pkh, swap.hEvm), next);
    return next;
  }

  async patchTrackedSwap(pkh: string, hEvm: string, patch: TrackedSwapPatch): Promise<TrackedSwap> {
    const prev = await this.loadTrackedSwap(pkh, hEvm);
    if (!prev) throw new SwapError(404, "tracked swap not found");
    const next: TrackedSwap = { ...prev, ...patch, hEvm: prev.hEvm, updatedAt: Date.now() };
    await this.storage.put(solverSwapKey(pkh, hEvm), next);
    return next;
  }

  async putSwapSecret(pkh: string, hEvm: string, secretHex: string): Promise<TrackedSwap> {
    const prev = await this.loadTrackedSwap(pkh, hEvm);
    if (!prev) throw new SwapError(404, "tracked swap not found");
    const next: TrackedSwap = { ...prev, secretHex, updatedAt: Date.now() };
    await this.storage.put(solverSwapKey(pkh, hEvm), next);
    return next;
  }

  async listPnl(pkh: string): Promise<PnlEntry[]> {
    return (await this.storage.get<PnlEntry[]>(pnlKey(pkh))) ?? [];
  }

  async appendPnl(pkh: string, entry: PnlEntry): Promise<void> {
    const all = await this.listPnl(pkh);
    all.push(entry);
    await this.storage.put(pnlKey(pkh), all);
  }

  // ── RFQ queue + heartbeat (ported from RfqBoard unchanged) ─────────────────

  async touchHeartbeat(pkh: string): Promise<void> {
    await this.storage.put(HEARTBEAT_KEY, { pkh, ts: Date.now() });
  }

  async online(): Promise<boolean> {
    const hb = await this.storage.get<{ ts: number }>(HEARTBEAT_KEY);
    return !!hb && Date.now() - hb.ts < HEARTBEAT_MAX_AGE_MS;
  }

  async createRfqRecord(side: RfqSide, amountIn: string): Promise<BoardRfqRecord | null> {
    if (!(await this.online())) return null;
    const now = Date.now();
    const rec: BoardRfqRecord = {
      id: randomId(),
      side,
      token: "USDC",
      amountIn,
      createdAt: now,
      expiresAt: now + RFQ_TTL_MS,
      status: "pending",
    };
    await this.storage.put(RFQ_PREFIX + rec.id, rec);
    return rec;
  }

  async getRfqRecord(rfqId: string): Promise<BoardRfqRecord | null> {
    const rec = await this.storage.get<BoardRfqRecord>(RFQ_PREFIX + rfqId);
    if (!rec) return null;
    if (rec.status === "pending" && Date.now() > rec.expiresAt) rec.status = "expired";
    return rec;
  }

  async listPendingRfqs(): Promise<BoardRfqRecord[]> {
    const all = await this.storage.list<BoardRfqRecord>({ prefix: RFQ_PREFIX });
    const now = Date.now();
    const pending: BoardRfqRecord[] = [];
    for (const [key, rec] of all) {
      const cutoff =
        rec.status === "pending"
          ? rec.expiresAt
          : (rec.respondedAt ?? rec.expiresAt) + ANSWERED_LINGER_MS;
      if (now > cutoff) {
        await this.storage.delete(key); // opportunistic cleanup
        continue;
      }
      if (rec.status === "pending") pending.push(rec);
    }
    pending.sort((a, b) => a.createdAt - b.createdAt);
    return pending;
  }

  async respondRfq(
    rfqId: string,
    pkh: string,
    body: {
      status: "ready" | "rejected";
      amountOut?: string;
      pricePerNock?: number;
      maxAmountIn?: string;
      reason?: string;
    }
  ): Promise<BoardRfqRecord> {
    const key = RFQ_PREFIX + rfqId;
    const rec = await this.storage.get<BoardRfqRecord>(key);
    if (!rec) throw new SwapError(404, "rfq not found");
    if (rec.status !== "pending") throw new SwapError(409, "rfq already answered");
    if (Date.now() > rec.expiresAt) throw new SwapError(410, "rfq expired");
    rec.status = body.status;
    rec.respondedAt = Date.now();
    rec.solverPkh = pkh;
    if (body.amountOut != null) rec.amountOut = body.amountOut;
    if (body.pricePerNock != null) rec.pricePerNock = body.pricePerNock;
    if (body.maxAmountIn != null) rec.maxAmountIn = body.maxAmountIn;
    if (body.reason != null) rec.reason = body.reason;
    await this.storage.put(key, rec);
    return rec;
  }

  // ── Sweep + import ──────────────────────────────────────────────────────────

  /** Drop swap/bid records untouched for RECORD_MAX_AGE_SEC (KV-TTL replacement).
   *  Called opportunistically from feed() consumers via the router. */
  async sweep(now = nowSec()): Promise<number> {
    let dropped = 0;
    const swaps = await this.storage.list<SwapRecord>({ prefix: SWAP_PREFIX });
    for (const [key, rec] of swaps) {
      const last = Number(rec.updatedAt ?? rec.createdAt ?? 0);
      if (now - last <= RECORD_MAX_AGE_SEC) continue;
      const k = key.slice(SWAP_PREFIX.length);
      await this.storage.delete(key);
      await this.storage.delete(OPEN_PREFIX + k);
      if (rec.sellerPkh) await this.storage.delete(mineKey(String(rec.sellerPkh), k));
      if (rec.buyerPkh) await this.storage.delete(mineKey(String(rec.buyerPkh), k));
      dropped++;
    }
    const bids = await this.storage.list<BidRecord>({ prefix: BID_PREFIX });
    for (const [key, rec] of bids) {
      if (now - rec.createdAt > RECORD_MAX_AGE_SEC) {
        await this.storage.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  /** One-time KV→DO migration: put-if-absent so re-runs are safe. */
  async importData(payload: ImportPayload): Promise<Record<string, number>> {
    const counts = { swaps: 0, bids: 0, bidFills: 0, solverSwaps: 0, pnl: 0 };
    for (const rec of payload.swaps ?? []) {
      if (!rec?.hEvm || (await this.loadSwap(String(rec.hEvm)))) continue;
      await this.writeSwap(rec);
      if (!rec.buyerPkh) await this.storage.put(OPEN_PREFIX + id(String(rec.hEvm)), id(String(rec.hEvm)));
      counts.swaps++;
    }
    for (const rec of payload.bids ?? []) {
      if (!rec?.id || (await this.loadBid(rec.id))) continue;
      await this.storage.put(BID_PREFIX + rec.id.toLowerCase(), rec);
      counts.bids++;
    }
    for (const [bidId, hEvm] of Object.entries(payload.bidFills ?? {})) {
      await this.storage.put(BID_FILLED_PREFIX + bidId.toLowerCase(), hEvm.toLowerCase());
      counts.bidFills++;
    }
    for (const [pkh, swaps] of Object.entries(payload.solverSwaps ?? {})) {
      for (const s of swaps) {
        if (!s?.hEvm || (await this.loadTrackedSwap(pkh, s.hEvm))) continue;
        await this.storage.put(solverSwapKey(pkh, s.hEvm), s);
        counts.solverSwaps++;
      }
    }
    for (const [pkh, entries] of Object.entries(payload.pnl ?? {})) {
      const existing = await this.listPnl(pkh);
      if (existing.length === 0 && entries.length > 0) {
        await this.storage.put(pnlKey(pkh), entries);
        counts.pnl += entries.length;
      }
    }
    return counts;
  }

}
