import { keccak256, type Hex, type Address } from "viem";
import { initRoseWasm, hashPreimage, jam, tasBelts } from "./rose.js";
import type { Digest } from '@nockbox/iris-sdk/wasm'

/**
 * Shared swap bundle (no preimage — revealed on Base withdraw). Persisted as JSON
 * in the KvStore keyed by `hEvm`. Secrets (seller preimage) live elsewhere
 * (IndexedDB SecretStore) and never appear here.
 */
export interface SwapPublic {
  hNock: Digest;
  hEvm: Hex;
  sellerPkh: Digest;
  buyerPkh: Digest;
  nockRefundHeight: bigint;
  usdcTimelock: bigint;
  nockGift: bigint;
  /** Seller's Base address — captured at creation so the buyer never types it. */
  sellerEth?: Address;
  /** Buyer's Base address — captured when the buyer locks USDC (enables indexing). */
  buyerEth?: Address;
  /** Human USDC amount for the swap (e.g. "1.5"). */
  usdcAmount?: string;
  /** Filled after seller locks NOCK; buyer needs this to claim (not the HTLC lock root). */
  lockFirstName?: Digest;
  /** HTLC OR lock tree root (from seller lock); buyer claim must use matching swap params. */
  lockRoot?: Digest;
  /** Seller's input note hash used for the lock tx (the "birth parent" of the HTLC gift note). */
  parentHash?: Digest;
  /** Output index of the HTLC gift note in the seller's lock tx. */
  birthOutputIndex?: number;
  /** Nockchain tx id from the seller's Lock NOCK step. */
  nockLockTxId?: string;
  /** Base tx hash from the buyer's Lock USDC step. */
  usdcLockTxHash?: string;
  /** Base tx hash from the seller's USDC withdraw. */
  usdcWithdrawTxHash?: string;
  /** Nockchain tx id from the buyer's claim. */
  nockClaimTxId?: string;
  /** Base tx hash from the buyer's USDC refund. */
  usdcRefundTxHash?: string;
  /** Nockchain tx id from the seller's NOCK refund. */
  nockRefundTxId?: string;
}

/**
 * Build swap secret: jam of a random 32-byte value as a belt-sequence noun.
 * Must use tasBelts (not tas): a single tas(hex) atom is too large for hashNoun/Tip5.
 */
export async function generateSwapSecret(): Promise<{
  preimageJam: Uint8Array;
  secretHex: string;
}> {
  await initRoseWasm();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const noun = tasBelts(hex);
  const preimageJam = jam(noun);
  return { preimageJam, secretHex: hex };
}

export async function computeHashes(preimageJam: Uint8Array): Promise<{
  hNock: Digest;
  hEvm: Hex;
}> {
  await initRoseWasm();
  // hNock must be the node's STRUCTURAL hash-noun (hash-varlen per belt leaf +
  // hash-ten-cell per cell), NOT iris `hashNoun` (hash-varlen over the whole noun),
  // or the HTLC hax check `=(h (hash-noun u.preimage))` can never match. See
  // ++ hax in nockchain/hoon/common/tx-engine-1.hoon
  const hNock = hashPreimage(preimageJam);
  const hEvm = keccak256(preimageJam);
  return { hNock, hEvm };
}

export function encodeSwapParams(params: SwapPublic): string {
  return JSON.stringify({
    hNock: params.hNock,
    hEvm: params.hEvm,
    sellerPkh: params.sellerPkh,
    buyerPkh: params.buyerPkh,
    ...(params.sellerEth ? { sellerEth: params.sellerEth } : {}),
    ...(params.buyerEth ? { buyerEth: params.buyerEth } : {}),
    ...(params.usdcAmount ? { usdcAmount: params.usdcAmount } : {}),
    ...(params.lockFirstName ? { lockFirstName: params.lockFirstName } : {}),
    ...(params.lockRoot ? { lockRoot: params.lockRoot } : {}),
    ...(params.parentHash ? { parentHash: params.parentHash } : {}),
    ...(typeof params.birthOutputIndex === 'number' ? { birthOutputIndex: params.birthOutputIndex } : {}),
    ...(params.nockLockTxId ? { nockLockTxId: params.nockLockTxId } : {}),
    ...(params.usdcLockTxHash ? { usdcLockTxHash: params.usdcLockTxHash } : {}),
    ...(params.usdcWithdrawTxHash ? { usdcWithdrawTxHash: params.usdcWithdrawTxHash } : {}),
    ...(params.nockClaimTxId ? { nockClaimTxId: params.nockClaimTxId } : {}),
    ...(params.usdcRefundTxHash ? { usdcRefundTxHash: params.usdcRefundTxHash } : {}),
    ...(params.nockRefundTxId ? { nockRefundTxId: params.nockRefundTxId } : {}),
    nockGift: params.nockGift.toString(),
    nockRefundHeight: params.nockRefundHeight.toString(),
    usdcTimelock: params.usdcTimelock.toString(),
  });
}

export function decodeSwapParams(json: string): SwapPublic {
  const raw = JSON.parse(json) as Record<string, string>;
  if (raw.preimageJam) {
    throw new Error(
      "Swap JSON must not include preimageJam — seller reveals it via Base withdraw"
    );
  }
  if (!raw.buyerPkh) {
    throw new Error(
      "Swap JSON missing buyerPkh — ask seller to regenerate with your Iris pkh"
    );
  }
  const str = (v: string | undefined): string | undefined =>
    v?.trim() ? v : undefined;
  return {
    hNock: raw.hNock as Digest,
    hEvm: raw.hEvm as Hex,
    sellerPkh: raw.sellerPkh as Digest,
    buyerPkh: raw.buyerPkh as Digest,
    nockRefundHeight: BigInt(raw.nockRefundHeight),
    usdcTimelock: BigInt(raw.usdcTimelock),
    nockGift: BigInt(raw.nockGift),
    sellerEth: str(raw.sellerEth) as Address | undefined,
    buyerEth: str(raw.buyerEth) as Address | undefined,
    usdcAmount: str(raw.usdcAmount),
    lockFirstName: str(raw.lockFirstName) as Digest | undefined,
    lockRoot: str(raw.lockRoot) as Digest | undefined,
    parentHash: str(raw.parentHash) as Digest | undefined,
    birthOutputIndex: raw.birthOutputIndex != null
      ? (typeof raw.birthOutputIndex === 'number' ? raw.birthOutputIndex : Number(raw.birthOutputIndex))
      : undefined,
    nockLockTxId: str(raw.nockLockTxId),
    usdcLockTxHash: str(raw.usdcLockTxHash),
    usdcWithdrawTxHash: str(raw.usdcWithdrawTxHash),
    nockClaimTxId: str(raw.nockClaimTxId),
    usdcRefundTxHash: str(raw.usdcRefundTxHash),
    nockRefundTxId: str(raw.nockRefundTxId),
  };
}

export function assertPreimageMatchesHashlock(
  preimageJam: Uint8Array,
  hEvm: Hex
): void {
  const hash = keccak256(preimageJam);
  if (hash !== hEvm) {
    throw new Error("Preimage does not match swap hEvm (wrong withdraw tx?)");
  }
}

/** Nock HTLC uses hash-noun(preimageJam); must match swap hNock before claim. */
export async function assertPreimageMatchesHNock(
  preimageJam: Uint8Array,
  hNock: Digest
): Promise<void> {
  await initRoseWasm();

  const got = hashPreimage(preimageJam);
  if (got !== hNock) {
    throw new Error(
      "Preimage does not match swap hNock — reload from Base withdraw or re-import swap JSON"
    );
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
