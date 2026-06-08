import type { Hex, Address } from "viem";
import type { SwapPublic } from "../swap.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { Digest, Nicks } from "@nockbox/iris-sdk/wasm";

/**
 * Buyer-side orchestration. Pure of storage: actions mutate/return the swap and
 * the caller persists via SwapRepository. Real deps are injected (default = lazy
 * import) so logic is unit-testable without network/wasm.
 *
 * THE claim path: keep the call into `claimNock` byte-for-byte identical.
 */

// ---------------------------------------------------------------------------
// lockUsdcAction
// ---------------------------------------------------------------------------

export interface LockUsdcDeps {
  approveAndLock(params: {
    seller: Address;
    amountUsdc: string;
    hashlock: Hex;
    timelock: bigint;
  }): Promise<{ swapId: Hex; lockHash: Hex; buyer: Address }>;
  htlcAddressSet(): boolean;
}

async function defaultLockUsdcDeps(): Promise<LockUsdcDeps> {
  const [{ approveAndLock }, { HTLC_ADDRESS }] = await Promise.all([
    import("../evm/htlc.js"),
    import("../config.js"),
  ]);
  return { approveAndLock, htlcAddressSet: () => Boolean(HTLC_ADDRESS) };
}

export async function lockUsdcAction(
  input: { swap: SwapPublic },
  deps?: LockUsdcDeps
): Promise<{ swapId: Hex; lockTxHash: Hex; swap: SwapPublic }> {
  const d = deps ?? (await defaultLockUsdcDeps());
  if (!d.htlcAddressSet()) {
    throw new Error(
      "Set VITE_HTLC_ADDRESS in .env at the repo root (see .env.example), then restart the dev server"
    );
  }
  if (!input.swap.sellerEth) {
    throw new Error("Swap is missing the seller's Base address — ask the seller to re-share");
  }
  if (!input.swap.usdcAmount) throw new Error("Swap is missing the USDC amount");

  const { swapId, lockHash, buyer } = await d.approveAndLock({
    seller: input.swap.sellerEth,
    amountUsdc: input.swap.usdcAmount,
    hashlock: input.swap.hEvm,
    timelock: input.swap.usdcTimelock,
  });
  input.swap.buyerEth = buyer;
  input.swap.usdcLockTxHash = lockHash;
  return { swapId, lockTxHash: lockHash, swap: input.swap };
}

// ---------------------------------------------------------------------------
// resolvePreimage — buyer's preimage comes from chain (public after withdraw)
// ---------------------------------------------------------------------------

export interface PreimageDeps {
  getPreimageFromWithdrawTx(tx: Hex): Promise<Uint8Array>;
  findPreimageFromSwapWithdraw(
    swapId: Hex
  ): Promise<{ txHash: string; preimageJam: Uint8Array }>;
  assertPreimageMatchesHNock(jam: Uint8Array, hNock: Digest): Promise<void>;
}

async function defaultPreimageDeps(): Promise<PreimageDeps> {
  const [{ getPreimageFromWithdrawTx, findPreimageFromSwapWithdraw }, { assertPreimageMatchesHNock }] =
    await Promise.all([import("../evm/preimage.js"), import("../swap.js")]);
  return {
    getPreimageFromWithdrawTx,
    findPreimageFromSwapWithdraw,
    assertPreimageMatchesHNock,
  };
}

export interface ResolvedPreimage {
  preimageJam: Uint8Array;
  txHash?: string;
}

export async function resolvePreimage(
  input: {
    swap: SwapPublic;
    cached: Uint8Array | null;
    withdrawTx: Hex | "";
    swapId: Hex | null;
  },
  deps?: PreimageDeps
): Promise<ResolvedPreimage> {
  if (input.cached) return { preimageJam: input.cached };

  const d = deps ?? (await defaultPreimageDeps());

  // Prefer an explicit manual tx, then the swap's recorded Base withdraw tx (set by
  // the seller on withdraw and shared via the swap record) — this is the auto-load
  // path so the buyer never has to paste a hash once the seller has withdrawn.
  const withdrawTx = (input.withdrawTx.trim() || input.swap.usdcWithdrawTxHash || "") as Hex | "";
  if (withdrawTx) {
    const jam = await d.getPreimageFromWithdrawTx(withdrawTx);
    await d.assertPreimageMatchesHNock(jam, input.swap.hNock);
    return { preimageJam: jam, txHash: withdrawTx };
  }

  if (!input.swapId) {
    throw new Error(
      "Preimage not loaded — the seller has not withdrawn USDC on Base yet. Once they do, it loads automatically (or paste their withdraw tx hash)."
    );
  }

  const { txHash, preimageJam } = await d.findPreimageFromSwapWithdraw(input.swapId);
  await d.assertPreimageMatchesHNock(preimageJam, input.swap.hNock);
  return { preimageJam, txHash };
}

// ---------------------------------------------------------------------------
// claimNockAction — THE claim path
// ---------------------------------------------------------------------------

export interface ClaimDeps {
  claimNock(params: {
    wallet: NockWalletSession;
    lockFirstName: Digest;
    preimageJam: Uint8Array;
    hNock: Digest;
    sellerPkh: Digest;
    buyerPkh: Digest;
    refundHeight: bigint;
    gift: Nicks;
    lockRoot?: Digest;
    parentHash?: Digest;
    birthOutputIndex?: number;
  }): Promise<string>;
  assertPreimageMatchesHNock(jam: Uint8Array, hNock: Digest): Promise<void>;
}

async function defaultClaimDeps(): Promise<ClaimDeps> {
  const [{ claimNock }, { assertPreimageMatchesHNock }] = await Promise.all([
    import("../nock/claim.js"),
    import("../swap.js"),
  ]);
  return { claimNock, assertPreimageMatchesHNock };
}

export async function claimNockAction(
  input: {
    wallet: NockWalletSession | null;
    swap: SwapPublic;
    preimageJam: Uint8Array | null;
    lockFirstName: string;
    gift: string;
  },
  deps?: ClaimDeps
): Promise<{ txId: string; swap: SwapPublic }> {
  if (!input.wallet) throw new Error("Connect Iris wallet first");
  if (!input.preimageJam) throw new Error("No preimage. Please load the swap.");

  const d = deps ?? (await defaultClaimDeps());

  await d.assertPreimageMatchesHNock(input.preimageJam, input.swap.hNock);

  const lockFirstNameRaw = input.lockFirstName || input.swap.lockFirstName || "";
  if (!lockFirstNameRaw.trim()) {
    throw new Error(
      "lockFirstName missing — seller must Lock NOCK and re-share swap JSON (gift output address, not lock tree root)"
    );
  }
  const lockFirstName = lockFirstNameRaw.trim() as Digest;
  const gift = (input.gift || input.swap.nockGift.toString()) as Nicks;

  const txId = await d.claimNock({
    wallet: input.wallet,
    lockFirstName,
    preimageJam: input.preimageJam,
    hNock: input.swap.hNock,
    sellerPkh: input.swap.sellerPkh,
    buyerPkh: input.swap.buyerPkh,
    refundHeight: input.swap.nockRefundHeight,
    gift,
    parentHash: input.swap.parentHash,
    birthOutputIndex: input.swap.birthOutputIndex,
  });
  input.swap.nockClaimTxId = txId;
  return { txId, swap: input.swap };
}

// ---------------------------------------------------------------------------
// refundUsdcAction — buyer reclaims USDC after the timelock
// ---------------------------------------------------------------------------

export interface RefundUsdcDeps {
  usdcToAtomic(amount: string): Promise<bigint>;
  computeSwapId(params: {
    seller: Hex;
    buyer: Hex;
    amount: bigint;
    hashlock: Hex;
    timelock: bigint;
  }): Promise<Hex>;
  refundUsdc(swapId: Hex): Promise<Hex>;
}

async function defaultRefundUsdcDeps(): Promise<RefundUsdcDeps> {
  const { usdcToAtomic, computeSwapId, refundUsdc } = await import("../evm/htlc.js");
  return { usdcToAtomic, computeSwapId, refundUsdc };
}

export async function refundUsdcAction(
  input: { swap: SwapPublic },
  deps?: RefundUsdcDeps
): Promise<{ hash: Hex; swap: SwapPublic }> {
  const { swap } = input;
  if (!swap.sellerEth || !swap.buyerEth) {
    throw new Error("Swap has no on-chain lock to refund");
  }
  if (!swap.usdcAmount) throw new Error("Swap is missing the USDC amount");
  const d = deps ?? (await defaultRefundUsdcDeps());

  const amount = await d.usdcToAtomic(swap.usdcAmount);
  const id = await d.computeSwapId({
    seller: swap.sellerEth,
    buyer: swap.buyerEth,
    amount,
    hashlock: swap.hEvm,
    timelock: swap.usdcTimelock,
  });
  const hash = await d.refundUsdc(id);
  swap.usdcRefundTxHash = hash;
  return { hash, swap };
}
