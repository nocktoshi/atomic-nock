/**
 * Buy orders ("bids"): a wNOCK/USDC holder offers to buy native NOCK. A bid has
 * no hashlock — the SECRET comes from whoever fills it. On fill, the filler
 * generates the preimage client-side and the bid converts into a perfectly
 * normal swap (filler = seller who locks NOCK first; bid creator = buyer who
 * locks the quote token on Base). Same protocol, same contracts, same state
 * machine — a bid only flips who initiates.
 */
import { createSwap, SwapError, type Env } from "./swaps.js";
import type { SwapRecord } from "./contract.js";

const BID_PREFIX = "bid:";
/** Tombstone left when a bid converts into a swap: `bidswap:<id>` → swap hEvm.
 *  Lets the creator's bid page redirect to the live swap after the fill. */
const BID_FILLED_PREFIX = "bidswap:";

/** Same TTL policy as swaps: expire 30 days after last write. */
const BID_TTL_SECONDS = 30 * 24 * 3600;

const ALLOWED_TOKENS = ["USDC", "WNOCK"] as const;

export interface BidRecord {
  id: string;
  /** Bidder's Nockchain pkh — receives native NOCK; bound to the session at create. */
  creatorPkh: string;
  /** Bidder's Base address — committed up front so the filled swap can pre-set
   *  buyerEth (the bidder must lock the quote token from this wallet). */
  creatorEth: string;
  /** Quote token the bidder PAYS on Base. */
  token: (typeof ALLOWED_TOKENS)[number];
  /** Human quote amount they pay (e.g. "85.50"). */
  quoteAmount: string;
  /** NOCK they want, in nicks (string bigint). */
  nockGift: string;
  createdAt: number;
  version: number;
}

function bidKey(id: string): string {
  return BID_PREFIX + id.toLowerCase();
}

export async function loadBid(env: Env, id: string): Promise<BidRecord | null> {
  const raw = await env.SWAPS.get(bidKey(id));
  return raw ? (JSON.parse(raw) as BidRecord) : null;
}

/** A bid, or where it went: open record, `{ filledHEvm }` after a fill, or null. */
export async function lookupBid(
  env: Env,
  id: string
): Promise<BidRecord | { filledHEvm: string } | null> {
  const bid = await loadBid(env, id);
  if (bid) return bid;
  const hEvm = await env.SWAPS.get(BID_FILLED_PREFIX + id.toLowerCase());
  return hEvm ? { filledHEvm: hEvm } : null;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Positive decimal string like "1", "0.5", "85.50" (no signs/exponents). */
function isPositiveDecimal(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(v) && parseFloat(v) > 0;
}

/** Positive integer string (nicks). */
function isPositiveInt(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,24}$/.test(v) && v !== "0".repeat(v.length);
}

/**
 * Create a bid. The session pkh becomes creatorPkh (you receive the NOCK you're
 * buying, so the bid is bound to your signed-in Nockchain wallet).
 */
export async function createBid(
  env: Env,
  body: Record<string, unknown>,
  sessionPkh: string
): Promise<BidRecord> {
  if (!ALLOWED_TOKENS.includes(body.token as (typeof ALLOWED_TOKENS)[number])) {
    throw new SwapError(400, `unknown token "${String(body.token)}"`);
  }
  if (!isPositiveDecimal(body.quoteAmount)) {
    throw new SwapError(400, "quoteAmount must be a positive decimal string");
  }
  if (!isPositiveInt(body.nockGift)) {
    throw new SwapError(400, "nockGift must be a positive integer string (nicks)");
  }
  if (typeof body.creatorEth !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.creatorEth)) {
    throw new SwapError(400, "creatorEth must be a Base address");
  }

  const rec: BidRecord = {
    id: randomId(),
    creatorPkh: sessionPkh,
    creatorEth: body.creatorEth,
    token: body.token as BidRecord["token"],
    quoteAmount: body.quoteAmount,
    nockGift: body.nockGift,
    createdAt: Math.floor(Date.now() / 1000),
    version: 1,
  };
  await env.SWAPS.put(bidKey(rec.id), JSON.stringify(rec), {
    expirationTtl: BID_TTL_SECONDS,
  });
  return rec;
}

/** Public listing: every open bid, newest first (filled/cancelled bids are deleted). */
export async function listBids(env: Env, limit = 50): Promise<BidRecord[]> {
  const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 50);
  const page = await env.SWAPS.list({ prefix: BID_PREFIX, limit: capped });
  const bids = await Promise.all(
    page.keys.map((k) => loadBid(env, k.name.slice(BID_PREFIX.length)))
  );
  return bids
    .filter((b): b is BidRecord => b !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Creator cancels their own open bid. */
export async function cancelBid(env: Env, id: string, sessionPkh: string): Promise<void> {
  const bid = await loadBid(env, id);
  if (!bid) throw new SwapError(404, "bid not found");
  if (bid.creatorPkh !== sessionPkh) {
    throw new SwapError(403, "only the bid creator may cancel it");
  }
  await env.SWAPS.delete(bidKey(id));
}

/**
 * Fill a bid: the filler (who holds native NOCK) generated a secret client-side
 * and posts the resulting swap. The economic identity is FORCED from the bid —
 * amounts, token, and the buyer (bid creator) cannot be tampered with. The
 * session pkh becomes the swap's seller (createSwap enforces the match).
 */
export async function fillBid(
  env: Env,
  id: string,
  swap: Record<string, unknown>,
  sessionPkh: string
): Promise<{ swap: SwapRecord; bid: BidRecord }> {
  const bid = await loadBid(env, id);
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
  const rec = await createSwap(env, forced, sessionPkh);
  // Fill consumes the bid. (KV is eventually consistent, so a cross-colo race
  // could briefly double-fill; the bidder simply proceeds with one swap and the
  // other dies unclaimed — no funds are ever at risk before the Base lock.)
  // The tombstone points the creator's bid page at the swap that replaced it.
  await Promise.all([
    env.SWAPS.delete(bidKey(id)),
    env.SWAPS.put(BID_FILLED_PREFIX + id.toLowerCase(), String(rec.hEvm).toLowerCase(), {
      expirationTtl: BID_TTL_SECONDS,
    }),
  ]);
  return { swap: rec, bid };
}
