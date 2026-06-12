/**
 * Public RFQ wire types — what the UI sees after POST /solver/rfq.
 * No pricing algorithm parameters (edges, impact, inventory, mid).
 */

export type RfqSide = "buy" | "sell";
export type RfqStatus = "pending" | "ready" | "rejected" | "expired" | "offline";

export interface SolverRfqResponse {
  rfqId: string;
  side: RfqSide;
  status: RfqStatus;
  /** Echo of the request amount (USDC for buy, NOCK for sell). */
  amountIn?: string;
  /** Priced output at this size (NOCK for buy, USDC for sell). */
  amountOut?: string;
  /** Effective USD per NOCK for this specific size. */
  pricePerNock?: number;
  /** Largest amountIn the solver will accept on this side right now. */
  maxAmountIn?: string;
  /** User-safe rejection reason (no internal params). */
  reason?: string;
  expiresAt: number;
}

export interface SolverStatus {
  online: boolean;
}