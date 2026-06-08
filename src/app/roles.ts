import type { SwapPublic } from "../swap.js";

export type Role = "seller" | "buyer";

export interface Connection {
  eth?: string | null;
  pkh?: string | null;
}

/** Determine the connected user's role in a swap from persisted participant data. */
export function roleForSwap(swap: SwapPublic, conn: Connection): Role | null {
  const eth = conn.eth?.toLowerCase();
  if (eth && swap.sellerEth?.toLowerCase() === eth) return "seller";
  if (eth && swap.buyerEth?.toLowerCase() === eth) return "buyer";
  if (conn.pkh && swap.sellerPkh === conn.pkh) return "seller";
  if (conn.pkh && swap.buyerPkh === conn.pkh) return "buyer";
  return null;
}

export type SwapStage =
  | "created"
  | "nock-locked"
  | "usdc-locked"
  | "withdrawn"
  | "claimed"
  | "refunded";

/** Most-advanced stage derivable from persisted fields. */
export function swapStatus(swap: SwapPublic): SwapStage {
  if (swap.usdcRefundTxHash || swap.nockRefundTxId) return "refunded";
  if (swap.nockClaimTxId) return "claimed";
  if (swap.usdcWithdrawTxHash) return "withdrawn";
  if (swap.usdcLockTxHash) return "usdc-locked";
  if (swap.lockFirstName || swap.nockLockTxId) return "nock-locked";
  return "created";
}

export interface OnchainLock {
  amount: bigint;
  withdrawn: boolean;
  refunded: boolean;
}

export interface RefundContext {
  nowSec: number;
  nockHeight?: number | null;
  onchainLock?: OnchainLock | null;
}

export interface RefundInfo {
  /** Buyer can reclaim USDC on Base (timelock elapsed, still locked). */
  eth: boolean;
  /** Seller can reclaim NOCK on Nockchain (refund height reached, not yet claimed). */
  nock: boolean;
}

export function refundAvailability(
  swap: SwapPublic,
  ctx: RefundContext
): RefundInfo {
  const ethReady =
    !!swap.usdcLockTxHash &&
    !swap.usdcWithdrawTxHash &&
    !swap.usdcRefundTxHash &&
    ctx.nowSec >= Number(swap.usdcTimelock) &&
    (ctx.onchainLock == null ||
      (ctx.onchainLock.amount > 0n &&
        !ctx.onchainLock.withdrawn &&
        !ctx.onchainLock.refunded));

  const nockReady =
    !!swap.lockFirstName &&
    !swap.nockClaimTxId &&
    !swap.nockRefundTxId &&
    ctx.nockHeight != null &&
    ctx.nockHeight >= Number(swap.nockRefundHeight);

  return { eth: ethReady, nock: nockReady };
}
