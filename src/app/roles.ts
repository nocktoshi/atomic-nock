import type { SwapPublic } from "../swap.js";

export type Role = "seller" | "buyer";

/** Connected wallets used to identify swap participants. */
export interface WalletConnection {
  eth?: string | null;
  nock?: { pkh: string; address?: string } | null;
}

function uniqueNonEmpty(values: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Iris session keys that may match swap `sellerPkh` / `buyerPkh`. */
export function nockWalletKeys(nock: WalletConnection["nock"]): string[] {
  if (!nock) return [];
  return uniqueNonEmpty([nock.pkh, nock.address]);
}

function nockPartyFlags(swap: SwapPublic, nock: WalletConnection["nock"]) {
  const keys = nockWalletKeys(nock);
  return {
    isSeller: keys.includes(swap.sellerPkh),
    isBuyer: keys.includes(swap.buyerPkh),
    ok: keys.some((k) => k === swap.sellerPkh || k === swap.buyerPkh),
  };
}

function evmPartyFlags(swap: SwapPublic, eth: string | null | undefined) {
  const e = eth?.toLowerCase();
  const sellerEth = swap.sellerEth?.toLowerCase();
  const buyerEth = swap.buyerEth?.toLowerCase();
  const isSeller = !!(e && sellerEth && e === sellerEth);
  const isBuyer = !!(e && buyerEth && e === buyerEth);
  return { isSeller, isBuyer, sellerEth, buyerEth, eth: e };
}

/** Determine the connected user's role in a swap from persisted participant data. */
export function roleForSwap(swap: SwapPublic, conn: WalletConnection): Role | null {
  const nock = nockPartyFlags(swap, conn.nock);
  const evm = evmPartyFlags(swap, conn.eth);

  if (nock.isSeller && evm.isSeller) return "seller";
  if (
    nock.isBuyer &&
    (evm.isBuyer || (!evm.buyerEth && evm.eth && evm.sellerEth && evm.eth !== evm.sellerEth))
  ) {
    return "buyer";
  }

  // Single-chain match (dashboard list before both wallets are connected).
  if (evm.isSeller) return "seller";
  if (evm.isBuyer) return "buyer";
  if (nock.isSeller) return "seller";
  if (nock.isBuyer) return "buyer";
  return null;
}

export interface SwapWalletVerification {
  ok: boolean;
  role: Role | null;
  nockOk: boolean;
  evmOk: boolean;
  issues: string[];
}

/**
 * For an existing swap, require Iris and Base to belong to the same party
 * (buyer or seller). Buyer Base may differ from `buyerEth` until they lock USDC.
 */
export function verifySwapWallets(
  swap: SwapPublic,
  conn: WalletConnection
): SwapWalletVerification {
  if (!swap.hEvm) {
    return {
      ok: true,
      role: null,
      nockOk: !!conn.nock,
      evmOk: !!conn.eth,
      issues: [],
    };
  }

  const nock = nockPartyFlags(swap, conn.nock);
  const evm = evmPartyFlags(swap, conn.eth);
  const evmOk =
    evm.isSeller ||
    evm.isBuyer ||
    !!(evm.eth && !evm.buyerEth && nock.isBuyer && evm.sellerEth && evm.eth !== evm.sellerEth);

  let role: Role | null = null;
  if (nock.isSeller && evm.isSeller) role = "seller";
  else if (
    nock.isBuyer &&
    (evm.isBuyer || (!evm.buyerEth && evm.eth && evm.sellerEth && evm.eth !== evm.sellerEth))
  ) {
    role = "buyer";
  }

  const issues: string[] = [];
  if (!conn.nock) {
    issues.push("Connect Iris (Nockchain wallet).");
  } else if (!nock.ok) {
    issues.push("Connected Iris wallet is not the buyer or seller for this swap.");
  }

  if (!conn.eth) {
    issues.push("Connect MetaMask (Base).");
  } else if (!evmOk) {
    issues.push("Connected Base wallet is not the buyer or seller for this swap.");
  }

  if (nock.ok && evmOk && !role) {
    issues.push(
      "Iris and MetaMask must be the same party — connect both wallets as the buyer or both as the seller."
    );
  }

  return {
    ok: nock.ok && evmOk && role != null,
    role,
    nockOk: nock.ok,
    evmOk,
    issues,
  };
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
