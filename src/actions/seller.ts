import type { Hex, Address } from "viem";
import { type SwapPublic, generateSwapSecret, computeHashes } from "../swap.js";
import {
  type TokenKey,
  DEFAULT_NOCK_REFUND_DELTA,
  DEFAULT_USDC_TIMEOUT_SEC,
  MIN_NOCK_NICKS,
  MIN_NOCK_AMOUNT,
} from "../config.js";
import type { LockNockResult, LockNockPreview } from "../nock/lock.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";
import { assertBase58Digest } from "../nock/tx.js";
import { usdcToAtomic, computeSwapId, withdrawUsdc } from "../evm/htlc.js";
import { secretStore } from "../app/storage/secret-store.js";
import type { BidPublic } from "../app/repo/swap-repo.js";

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

function defaultGenerateSwapDeps(): GenerateSwapDeps {
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
    buyerPkh: string;
    walletAddress: string;
    /** Seller's connected Base address — persisted so the buyer never types it. */
    sellerEth: string;
    usdcAmount: string;
    gift: string;
    refundHeight: string;
    /** Quote token on Base; absent = USDC. */
    token?: TokenKey;
    /** Override the USDC window (seconds). Solver-facing flows use SHORT
     *  windows — the window is the counterparty's free option. */
    usdcTimeoutSec?: number;
  },
  deps?: GenerateSwapDeps
): Promise<{ swap: SwapPublic; preimageJam: Uint8Array; refundHeight: bigint }> {
  const d = deps ?? defaultGenerateSwapDeps();

  // buyerPkh is optional: an OPEN swap is posted with no buyer and the buyer
  // commits later via the shared link (their pkh is set from their session).
  const buyerPkh = input.buyerPkh.trim();
  if (buyerPkh) d.assertBase58Digest("buyerPkh", buyerPkh);

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
  if (gift < MIN_NOCK_NICKS) {
    throw new Error(
      `Minimum NOCK amount is ${MIN_NOCK_AMOUNT} NOCK (to cover on-chain fees).`
    );
  }
  const refundHeight = input.refundHeight ? BigInt(input.refundHeight) : 0n;
  if (refundHeight <= 0n) {
    throw new Error(
      "Refund block height is required — reconnect Iris so it can default to the current height + " +
        `${d.refundDelta} blocks.`
    );
  }
  const usdcTimelock = BigInt(
    Math.floor(Date.now() / 1000) + (input.usdcTimeoutSec ?? d.usdcTimeoutSec)
  );
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
    token: input.token,
  };

  return { swap, preimageJam, refundHeight };
}

// ---------------------------------------------------------------------------
// fillBidAction — NOCK holder fills a buy order (becomes the swap's seller)
// ---------------------------------------------------------------------------

/**
 * Build the swap that fills a bid. Same generation path as a fresh ask — the
 * filler holds the secret and locks NOCK first — but every economic field comes
 * from the bid, and the bid creator is pre-committed as the buyer (including
 * their Base address, so they skip the claim step and go straight to locking).
 * Caller persists the preimage + posts via repo.fillBid.
 */
export async function fillBidAction(
  input: {
    bid: BidPublic;
    /** Filler's nockblocks wallet address (becomes sellerPkh). */
    walletAddress: string;
    /** Filler's Base address (receives the quote token on withdraw). */
    sellerEth: string;
    refundHeight: string;
    /** Override the USDC window (seconds) — see generateSwapAction. */
    usdcTimeoutSec?: number;
  },
  deps?: GenerateSwapDeps
): Promise<{ swap: SwapPublic; preimageJam: Uint8Array }> {
  const { swap, preimageJam } = await generateSwapAction(
    {
      buyerPkh: input.bid.creatorPkh,
      walletAddress: input.walletAddress,
      sellerEth: input.sellerEth,
      usdcAmount: input.bid.quoteAmount,
      gift: input.bid.nockGift.toString(),
      refundHeight: input.refundHeight,
      token: input.bid.token,
      usdcTimeoutSec: input.usdcTimeoutSec,
    },
    deps
  );
  swap.buyerEth = input.bid.creatorEth;
  return { swap, preimageJam };
}

// ---------------------------------------------------------------------------
// lockNockAction
// ---------------------------------------------------------------------------

export interface LockNockDeps {
  isPlausibleWalletAddress(v: string): boolean;
  lockNock(params: {
    walletAddress: Digest;
    buyerPkh: Digest;
    gift: bigint;
    hNock: Digest;
    refundHeight: bigint;
    swapLockFirstName?: Digest;
  }): Promise<LockNockFull>;
}

function defaultLockNockDeps(): LockNockDeps {
  return {
    isPlausibleWalletAddress,
    lockNock: async () => {
      throw new Error(
        "lockNock requires a connected Iris wallet — use lockNockAction from useSession()"
      );
    },
  };
}

export async function lockNockAction(
  input: {
    swap: SwapPublic | null;
    walletAddress: string;
  },
  deps?: LockNockDeps
): Promise<{ result: LockNockFull; swap: SwapPublic }> {
  if (!input.swap) throw new Error("Generate swap first");
  const d = deps ?? defaultLockNockDeps();

  const walletAddress = input.walletAddress.trim() as Digest;
  if (!d.isPlausibleWalletAddress(walletAddress)) {
    throw new Error(
      "Enter your nockblocks wallet address (base58, ~51 chars). Iris pkh cannot be used here."
    );
  }

  const result = await d.lockNock({
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
  getSellerPreimage(hEvm: Hex): Promise<Uint8Array | null>;
  withdrawUsdc(params: {
    swapId: Hex;
    preimageJam: Uint8Array;
    token?: TokenKey;
  }): Promise<Hex>;
}

function defaultWithdrawUsdcDeps(): WithdrawUsdcDeps {
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
  if (!swap.usdcAmount) throw new Error("Swap is missing the quote amount");
  const d = deps ?? defaultWithdrawUsdcDeps();

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
  const preimageJam = await d.getSellerPreimage(swap.hEvm);
  if (!preimageJam) {
    throw new Error(
      "Preimage not found on this device — withdraw must run on the machine that created the swap"
    );
  }
  const hash = await d.withdrawUsdc({ swapId: id, preimageJam, token: swap.token });
  swap.usdcWithdrawTxHash = hash;
  return { hash, swap };
}

// ---------------------------------------------------------------------------
// refundNockAction — seller reclaims locked NOCK after the refund height
// ---------------------------------------------------------------------------

export interface RefundNockDeps {
  refundNock(swap: SwapPublic): Promise<string>;
}

async function defaultRefundNockDeps(): Promise<RefundNockDeps> {
  return {
    refundNock: async () => {
      throw new Error(
        "refundNock requires a connected Iris wallet — use refundNockAction from useSession()"
      );
    },
  };
}

export async function refundNockAction(
  input: { swap: SwapPublic | null },
  deps?: RefundNockDeps
): Promise<{ txId: string; swap: SwapPublic }> {
  if (!input.swap) throw new Error("No swap selected");
  if (!input.swap.lockFirstName) throw new Error("Nothing locked to refund");
  const d = deps ?? (await defaultRefundNockDeps());
  const txId = await d.refundNock(input.swap);
  input.swap.nockRefundTxId = txId;
  return { txId, swap: input.swap };
}
