import type { Hex, Address } from "viem";
import type { SwapPublic } from "../swap.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { LockNockResult, LockNockPreview } from "../nock/lock.js";

type LockNockFull = LockNockResult & { preview: LockNockPreview };
import type { Digest } from "@nockbox/iris-sdk/wasm";

/**
 * Seller-side orchestration. Pure of storage: each action returns the updated
 * swap (+ any secret) and the caller persists via SwapRepository / SecretStore.
 * Real deps are injected (default = lazy import) so logic is unit-testable.
 */

// ---------------------------------------------------------------------------
// generateSwapAction
// ---------------------------------------------------------------------------

export interface GenerateSwapDeps {
  generateSwapSecret(): Promise<{ preimageJam: Uint8Array; secretHex: string }>;
  computeHashes(jam: Uint8Array): Promise<{ hNock: Digest; hEvm: Hex }>;
  isPlausibleWalletAddress(v: string): boolean;
  assertBase58Digest(label: string, val: unknown): void;
  refundDelta: bigint;
  usdcTimeoutSec: number;
}

async function defaultGenerateSwapDeps(): Promise<GenerateSwapDeps> {
  const [
    { generateSwapSecret, computeHashes },
    { isPlausibleWalletAddress },
    { assertBase58Digest },
    { DEFAULT_NOCK_REFUND_DELTA, DEFAULT_USDC_TIMEOUT_SEC },
  ] = await Promise.all([
    import("../swap.js"),
    import("../nock/balance.js"),
    import("../nock/tx.js"),
    import("../config.js"),
  ]);
  return {
    generateSwapSecret,
    computeHashes,
    isPlausibleWalletAddress,
    assertBase58Digest,
    refundDelta: DEFAULT_NOCK_REFUND_DELTA,
    usdcTimeoutSec: DEFAULT_USDC_TIMEOUT_SEC,
  };
}

export async function generateSwapAction(
  input: {
    wallet: NockWalletSession | null;
    buyerPkh: string;
    walletAddress: string;
    /** Seller's connected Base address — persisted so the buyer never types it. */
    sellerEth: string;
    usdcAmount: string;
    gift: string;
    refundHeight: string;
  },
  deps?: GenerateSwapDeps
): Promise<{ swap: SwapPublic; preimageJam: Uint8Array; refundHeight: bigint }> {
  if (!input.wallet) throw new Error("Connect Iris wallet first");
  const d = deps ?? (await defaultGenerateSwapDeps());

  const buyerPkh = input.buyerPkh.trim();
  if (!buyerPkh) throw new Error("Enter buyer Nockchain pkh (from buyer's Iris wallet)");
  d.assertBase58Digest("buyerPkh", buyerPkh);

  const walletAddr = input.walletAddress.trim();
  if (!d.isPlausibleWalletAddress(walletAddr)) {
    throw new Error(
      "Enter your nockblocks wallet address before generating swap (sellerPkh for HTLC refund)"
    );
  }
  d.assertBase58Digest("sellerPkh (nockblocks wallet address)", walletAddr);

  const sellerEth = input.sellerEth.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(sellerEth)) {
    throw new Error("Connect MetaMask so the swap records your Base address");
  }
  if (!input.usdcAmount.trim()) throw new Error("Enter the USDC amount for the swap");

  const { preimageJam } = await d.generateSwapSecret();
  const { hNock, hEvm } = await d.computeHashes(preimageJam);

  const gift = BigInt(input.gift);
  let refundHeight = input.refundHeight ? BigInt(input.refundHeight) : 0n;
  if (refundHeight === 0n) refundHeight = 1_000_000n + d.refundDelta;
  const usdcTimelock = BigInt(Math.floor(Date.now() / 1000) + d.usdcTimeoutSec);

  const swap: SwapPublic = {
    hNock,
    hEvm,
    sellerPkh: walletAddr as Digest,
    buyerPkh: buyerPkh as Digest,
    sellerEth: sellerEth as Address,
    usdcAmount: input.usdcAmount.trim(),
    nockRefundHeight: refundHeight,
    usdcTimelock,
    nockGift: gift,
  };

  return { swap, preimageJam, refundHeight };
}

// ---------------------------------------------------------------------------
// lockNockAction
// ---------------------------------------------------------------------------

export interface LockNockDeps {
  isPlausibleWalletAddress(v: string): boolean;
  lockNock(params: {
    wallet: NockWalletSession;
    walletAddress: Digest;
    buyerPkh: Digest;
    gift: bigint;
    hNock: Digest;
    refundHeight: bigint;
    swapLockFirstName?: Digest;
  }): Promise<LockNockFull>;
}

async function defaultLockNockDeps(): Promise<LockNockDeps> {
  const [{ isPlausibleWalletAddress }, { lockNock }] = await Promise.all([
    import("../nock/balance.js"),
    import("../nock/lock.js"),
  ]);
  return { isPlausibleWalletAddress, lockNock };
}

export async function lockNockAction(
  input: {
    wallet: NockWalletSession | null;
    swap: SwapPublic | null;
    walletAddress: string;
  },
  deps?: LockNockDeps
): Promise<{ result: LockNockFull; swap: SwapPublic }> {
  if (!input.swap) throw new Error("Generate swap first");
  if (!input.wallet) throw new Error("Connect Iris wallet first");
  const d = deps ?? (await defaultLockNockDeps());

  const walletAddress = input.walletAddress.trim() as Digest;
  if (!d.isPlausibleWalletAddress(walletAddress)) {
    throw new Error(
      "Enter your nockblocks wallet address (base58, ~51 chars). Iris pkh cannot be used here."
    );
  }

  const result = await d.lockNock({
    wallet: input.wallet,
    walletAddress,
    buyerPkh: input.swap.buyerPkh,
    gift: input.swap.nockGift,
    hNock: input.swap.hNock,
    refundHeight: input.swap.nockRefundHeight,
    swapLockFirstName: input.swap.lockFirstName,
  });

  const swap = input.swap;
  swap.sellerPkh = walletAddress;
  swap.lockFirstName = result.lockFirstName as Digest;
  swap.lockRoot = result.preview.lockRoot as Digest;
  swap.nockLockTxId = result.txId;
  if (result.parentHash) swap.parentHash = result.parentHash as Digest;
  if (typeof result.birthOutputIndex === "number") {
    swap.birthOutputIndex = result.birthOutputIndex;
  }

  return { result, swap };
}

// ---------------------------------------------------------------------------
// withdrawUsdcAction — seller reveals preimage on Base to claim USDC
// ---------------------------------------------------------------------------

export interface WithdrawUsdcDeps {
  usdcToAtomic(amount: string): Promise<bigint>;
  computeSwapId(params: {
    seller: Hex;
    buyer: Hex;
    amount: bigint;
    hashlock: Hex;
    timelock: bigint;
  }): Promise<Hex>;
  getSellerPreimage(hEvm: Hex): Promise<Uint8Array | null>;
  withdrawUsdc(params: { swapId: Hex; preimageJam: Uint8Array }): Promise<Hex>;
}

async function defaultWithdrawUsdcDeps(): Promise<WithdrawUsdcDeps> {
  const [{ usdcToAtomic, computeSwapId, withdrawUsdc }, { secretStore }] =
    await Promise.all([
      import("../evm/htlc.js"),
      import("../app/storage/secret-store.js"),
    ]);
  return {
    usdcToAtomic,
    computeSwapId,
    getSellerPreimage: secretStore.getSellerPreimage.bind(secretStore),
    withdrawUsdc,
  };
}

export async function withdrawUsdcAction(
  input: { swap: SwapPublic | null },
  deps?: WithdrawUsdcDeps
): Promise<{ hash: Hex; swap: SwapPublic }> {
  if (!input.swap) throw new Error("Generate swap first");
  const swap = input.swap;
  if (!swap.sellerEth || !swap.buyerEth) {
    throw new Error("Buyer must lock USDC before you can withdraw");
  }
  if (!swap.usdcAmount) throw new Error("Swap is missing the USDC amount");
  const d = deps ?? (await defaultWithdrawUsdcDeps());

  const amount = await d.usdcToAtomic(swap.usdcAmount);
  const id = await d.computeSwapId({
    seller: swap.sellerEth,
    buyer: swap.buyerEth,
    amount,
    hashlock: swap.hEvm,
    timelock: swap.usdcTimelock,
  });
  const preimageJam = await d.getSellerPreimage(swap.hEvm);
  if (!preimageJam) {
    throw new Error(
      "Preimage not found on this device — withdraw must run on the machine that created the swap"
    );
  }
  const hash = await d.withdrawUsdc({ swapId: id, preimageJam });
  swap.usdcWithdrawTxHash = hash;
  return { hash, swap };
}

// ---------------------------------------------------------------------------
// refundNockAction — seller reclaims locked NOCK after the refund height
// ---------------------------------------------------------------------------

export interface RefundNockDeps {
  refundNock(params: {
    wallet: NockWalletSession;
    swap: SwapPublic;
  }): Promise<string>;
}

async function defaultRefundNockDeps(): Promise<RefundNockDeps> {
  const { refundNock } = await import("../nock/refund.js");
  return { refundNock };
}

export async function refundNockAction(
  input: { wallet: NockWalletSession | null; swap: SwapPublic | null },
  deps?: RefundNockDeps
): Promise<{ txId: string; swap: SwapPublic }> {
  if (!input.swap) throw new Error("No swap selected");
  if (!input.wallet) throw new Error("Connect Iris wallet first");
  if (!input.swap.lockFirstName) throw new Error("Nothing locked to refund");
  const d = deps ?? (await defaultRefundNockDeps());
  const txId = await d.refundNock({ wallet: input.wallet, swap: input.swap });
  input.swap.nockRefundTxId = txId;
  return { txId, swap: input.swap };
}
