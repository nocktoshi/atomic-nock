/**
 * Wire contract between the client and the Worker. The Worker is authoritative:
 * it owns the swap state machine and enforces every invariant below. The client
 * mirrors these shapes.
 *
 * Field authorization model
 * -------------------------
 *  - IMMUTABLE_FIELDS   : set once at creation, can never change. These are the
 *                         swap's economic identity (hashlock, amount, timelock,
 *                         seller). Their immutability is what makes the swapId
 *                         stable — tampering is rejected, not silently merged.
 *  - BUYER_CLAIM_FIELDS : the buyer's identity. Settable once — either by the
 *                         seller at creation (directed swap) or by the buyer via
 *                         /claim (open swap). On /claim, buyerPkh is taken from
 *                         the authenticated session, NOT the request body, so it
 *                         cannot be spoofed. Immutable thereafter.
 *  - SELLER_FIELDS      : progress fields only the verified seller may write.
 *  - BUYER_FIELDS       : progress fields only the verified buyer may write.
 */

export const IMMUTABLE_FIELDS = [
  "hEvm",
  "hNock",
  "usdcTimelock",
  "nockGift",
  "nockRefundHeight",
  "sellerEth",
  "sellerPkh",
  "usdcAmount",
  "swapId",
  "token",
  "createdAt",
] as const;

export const BUYER_CLAIM_FIELDS = ["buyerPkh", "buyerEth"] as const;

export const SELLER_FIELDS = [
  "lockFirstName",
  "lockRoot",
  "parentHash",
  "birthOutputIndex",
  "nockLockTxId",
  "usdcWithdrawTxHash",
  "nockRefundTxId",
] as const;

export const BUYER_FIELDS = [
  "usdcLockTxHash",
  "nockClaimTxId",
  "usdcRefundTxHash",
] as const;

/** A stored swap record (string-encoded bigints, same shape the client uses). */
export type SwapRecord = Record<string, unknown> & {
  hEvm: string;
  sellerPkh: string;
  buyerPkh?: string;
  buyerEth?: string;
  sellerEth?: string;
  version: number;
};

/** Body for POST /swap (seller-signed session). */
export interface CreateBody {
  swap: Record<string, unknown>; // SwapPublic-encoded fields
}

/** Body for POST /swap/:id/claim (buyer-signed session). buyerPkh comes from the session. */
export interface ClaimBody {
  buyerEth: string;
}

/** Body for POST /swap/:id/advance (party-signed session). */
export interface AdvanceBody {
  fields: Record<string, unknown>; // a subset of SELLER_FIELDS or BUYER_FIELDS
  expectedVersion?: number; // optimistic concurrency (optional)
}

/** Auth payload posted to /auth/login. */
export interface LoginBody {
  challenge: string;
  challengeMac: string;
  pubkeyHex: string;
  signature: { c: string; s: string };
}
