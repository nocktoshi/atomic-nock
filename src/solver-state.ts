/**
 * Wire contract for solver tracking state (Worker KV + solver daemon RAM cache).
 * Shared by worker/src/solver-store.ts and solver/src/store.ts.
 */

export type SolverRole = "buyer" | "seller";

export interface TrackedSwap {
  hEvm: string;
  role: SolverRole;
  /** Last phase the daemon advanced this swap through (for resume + logging). */
  phase: string;
  /** Quote USD, for open-exposure accounting. */
  quoteUsd: number;
  /** NOCK (nicks) at stake. */
  nockNicks: string;
  createdAt: number;
  updatedAt: number;
  /** Terminal swaps stay for the ledger but drop out of exposure. */
  done: boolean;
  /** Seller-only preimage (hex), persisted before the NOCK-lock broadcast. */
  secretHex?: string;
  /** Buyer-only: Nockchain height when the seller's NOCK lock was first seen. */
  lockSeenHeight?: number;
  /** Seller-only: last note consolidation broadcast (ms). */
  consolidatedAt?: number;
}

export interface PnlEntry {
  hEvm: string;
  ts: number;
  /** Signed deltas from the solver's perspective. */
  nockDelta: number;
  usdDelta: number;
  note: string;
}

/** Fields PATCH /solver/state/swaps/:hEvm may merge. */
export type TrackedSwapPatch = Partial<
  Pick<
    TrackedSwap,
    "phase" | "done" | "lockSeenHeight" | "consolidatedAt" | "quoteUsd" | "nockNicks" | "updatedAt"
  >
>;

export interface SwapsListResponse {
  swaps: TrackedSwap[];
}

export interface PnlListResponse {
  pnl: PnlEntry[];
}

export interface PnlSummaryResponse {
  nock: number;
  usd: number;
  count: number;
}