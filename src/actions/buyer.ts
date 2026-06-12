import type { Hex, Address } from "viem";
import { type SwapPublic, assertPreimageMatchesHNock } from "../swap.js";
import { type TokenKey, tokenInfo } from "../config.js";
import { approveAndLock, usdcToAtomic, computeSwapId, refundUsdc } from "../evm/htlc.js";
import { getPreimageFromWithdrawTx, findPreimageFromSwapWithdraw } from "../evm/preimage.js";
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
    token?: TokenKey;
  }): Promise<{ swapId: Hex; lockHash: Hex; buyer: Address }>;
  htlcAddressSet(token?: TokenKey): boolean;
}

function defaultLockUsdcDeps(): LockUsdcDeps {
  return { approveAndLock, htlcAddressSet: (token) => Boolean(tokenInfo(token).htlc) };
}

export async function lockUsdcAction(
  input: { swap: SwapPublic },
  deps?: LockUsdcDeps
): Promise<{ swapId: Hex; lockTxHash: Hex; swap: SwapPublic }> {
  const d = deps ?? defaultLockUsdcDeps();
  if (!d.htlcAddressSet(input.swap.token)) {
    throw new Error(
      input.swap.token === "WNOCK"
        ? "wNOCK HTLC not deployed — set VITE_HTLC_ADDRESS_WNOCK"
        : "Set VITE_HTLC_ADDRESS in .env at the repo root (see .env.example), then restart the dev server"
    );
  }
  if (!input.swap.sellerEth) {
    throw new Error("Swap is missing the seller's Base address — ask the seller to re-share");
  }
  if (!input.swap.usdcAmount) throw new Error("Swap is missing the quote amount");

  const { swapId, lockHash, buyer } = await d.approveAndLock({
    seller: input.swap.sellerEth,
    amountUsdc: input.swap.usdcAmount,
    hashlock: input.swap.hEvm,
    timelock: input.swap.usdcTimelock,
    token: input.swap.token,
  });
  input.swap.buyerEth = buyer;
  input.swap.usdcLockTxHash = lockHash;
  return { swapId, lockTxHash: lockHash, swap: input.swap };
}

// ---------------------------------------------------------------------------
// resolvePreimage — buyer's preimage comes from chain (public after withdraw)
// ---------------------------------------------------------------------------

export interface PreimageDeps {
  getPreimageFromWithdrawTx(tx: Hex, token?: TokenKey): Promise<Uint8Array>;
  findPreimageFromSwapWithdraw(
    swapId: Hex,
    token?: TokenKey
  ): Promise<{ txHash: string; preimageJam: Uint8Array }>;
  assertPreimageMatchesHNock(jam: Uint8Array, hNock: Digest): Promise<void>;
}

function defaultPreimageDeps(): PreimageDeps {
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

  const d = deps ?? defaultPreimageDeps();

  // Prefer an explicit manual tx, then the swap's recorded Base withdraw tx (set by
  // the seller on withdraw and shared via the swap record) — this is the auto-load
  // path so the buyer never has to paste a hash once the seller has withdrawn.
  const withdrawTx = (input.withdrawTx.trim() || input.swap.usdcWithdrawTxHash || "") as Hex | "";
  if (withdrawTx) {
    const jam = await d.getPreimageFromWithdrawTx(withdrawTx, input.swap.token);
    await d.assertPreimageMatchesHNock(jam, input.swap.hNock);
    return { preimageJam: jam, txHash: withdrawTx };
  }

  if (!input.swapId) {
    throw new Error(
      "Preimage not loaded — the seller has not withdrawn on Base yet. Once they do, it loads automatically (or paste their withdraw tx hash)."
    );
  }

  const { txHash, preimageJam } = await d.findPreimageFromSwapWithdraw(
    input.swapId,
    input.swap.token
  );
  await d.assertPreimageMatchesHNock(preimageJam, input.swap.hNock);
  return { preimageJam, txHash };
}

// ---------------------------------------------------------------------------
// claimNockAction — THE claim path
// ---------------------------------------------------------------------------

export interface ClaimDeps {
  claimNock(params: {
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
  }): Promise<{ txId: string; fee: bigint; received: bigint }>;
  assertPreimageMatchesHNock(jam: Uint8Array, hNock: Digest): Promise<void>;
}

function defaultClaimDeps(): ClaimDeps {
  return {
    claimNock: async () => {
      throw new Error(
        "claimNock requires a connected Iris wallet — use claimNockAction from useSession()"
      );
    },
    assertPreimageMatchesHNock,
  };
}

export async function claimNockAction(
  input: {
    swap: SwapPublic;
    preimageJam: Uint8Array | null;
    lockFirstName: string;
    gift: string;
  },
  deps?: ClaimDeps
): Promise<{ txId: string; swap: SwapPublic; fee: bigint; received: bigint }> {
  if (!input.preimageJam) throw new Error("No preimage. Please load the swap.");

  const d = deps ?? defaultClaimDeps();

  await d.assertPreimageMatchesHNock(input.preimageJam, input.swap.hNock);

  const lockFirstNameRaw = input.lockFirstName || input.swap.lockFirstName || "";
  if (!lockFirstNameRaw.trim()) {
    throw new Error(
      "lockFirstName missing — seller must Lock NOCK and re-share swap JSON (gift output address, not lock tree root)"
    );
  }
  const lockFirstName = lockFirstNameRaw.trim() as Digest;
  const gift = (input.gift || input.swap.nockGift.toString()) as Nicks;

  const { txId, fee, received } = await d.claimNock({
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
  return { txId, swap: input.swap, fee, received };
}

// ---------------------------------------------------------------------------
// refundUsdcAction — buyer reclaims USDC after the timelock
// ---------------------------------------------------------------------------

export interface RefundUsdcDeps {
  usdcToAtomic(amount: string, token?: TokenKey): Promise<bigint>;
  computeSwapId(
    params: {
      seller: Hex;
      buyer: Hex;
      amount: bigint;
      hashlock: Hex;
      timelock: bigint;
    },
    token?: TokenKey
  ): Promise<Hex>;
  refundUsdc(swapId: Hex, token?: TokenKey): Promise<Hex>;
}

function defaultRefundUsdcDeps(): RefundUsdcDeps {
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
  if (!swap.usdcAmount) throw new Error("Swap is missing the quote amount");
  const d = deps ?? defaultRefundUsdcDeps();

  const amount = await d.usdcToAtomic(swap.usdcAmount, swap.token);
  const id = await d.computeSwapId(
    {
      seller: swap.sellerEth,
      buyer: swap.buyerEth,
      amount,
      hashlock: swap.hEvm,
      timelock: swap.usdcTimelock,
    },
    swap.token
  );
  const hash = await d.refundUsdc(id, swap.token);
  swap.usdcRefundTxHash = hash;
  return { hash, swap };
}
