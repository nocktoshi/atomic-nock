import type { Address } from "viem";
import { base } from "viem/chains";

/** Set explicitly to override; empty = same-origin Vite proxy in dev or public RPC. */
export const ENVOY_URL = (import.meta.env.VITE_ENVOY_URL ?? "").trim();

export const NOCK_GRPC_UPSTREAM =
  import.meta.env.VITE_NOCK_GRPC_UPSTREAM ?? "https://rpc.nockchain.net";

export const CHAIN = base;
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? base.id);

/** Ethereum mainnet RPC for ENS lookups. Must allow browser CORS. The viem
 *  default (eth.merkle.io) does not, so we default to a CORS-friendly endpoint. */
export const ETH_RPC_URL = (
  import.meta.env.VITE_ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com"
).trim();

export const USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

export const HTLC_ADDRESS = (import.meta.env.VITE_HTLC_ADDRESS ??
  "0x5ac37e7A63b107d226d0b88129B8EB8b07172B75") as Address;

/** Swap API base URL (the Worker). Empty in dev = in-memory store (not durable). */
const kvFromEnv = (import.meta.env.VITE_KV_URL ?? "").trim();
export const KV_URL =
  kvFromEnv || (import.meta.env.PROD ? "https://api.atomicnock.com" : "");

/** Market price feed (NOCK/USD). Empty in dev = price hidden. */
const priceFromEnv = (import.meta.env.VITE_PRICE_URL ?? "").trim();
export const PRICE_URL =
  priceFromEnv ||
  (import.meta.env.PROD
    ? "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&symbols=nock"
    : "");

// --- Cross-chain timelock safety ---------------------------------------------
// The seller holds the preimage and reveals it by withdrawing USDC; the buyer's
// NOCK claim depends on that reveal. So the NOCK refund (seller reclaim) MUST land
// well AFTER the USDC refund (buyer reclaim): that lets the buyer (a) always claim
// NOCK after the seller reveals, and (b) refund USDC before the seller can reclaim
// NOCK. The OPPOSITE ordering lets a malicious seller reclaim NOCK and still take
// the USDC. Invariant enforced client-side at lock time (see verifyNockLockConfirmed):
//   wallclock(nockRefundHeight) >= usdcTimelock + SWAP_SAFETY_MARGIN_SEC

/** Nockchain block time (~2.5 min) — used to convert a refund height to wall-clock. */
export const NOCK_BLOCK_SECONDS = 150;

/** USDC refund window (buyer reclaim). Kept SHORTER than the NOCK refund window. */
export const DEFAULT_USDC_TIMEOUT_SEC = 12 * 3600; // 12h

/** NOCK refund delay in blocks (seller reclaim), ~30h at 2.5 min/block. Must stay
 *  comfortably ABOVE DEFAULT_USDC_TIMEOUT_SEC + SWAP_SAFETY_MARGIN_SEC. */
export const DEFAULT_NOCK_REFUND_DELTA = 720n;

/** Required slack between the USDC refund and the NOCK refund (absorbs NOCK
 *  block-rate variance + the buyer's reaction time). */
export const SWAP_SAFETY_MARGIN_SEC = 4 * 3600; // 4h

/** Refuse to lock USDC into a swap whose USDC refund opens sooner than this. */
export const MIN_USDC_WINDOW_SEC = 60 * 60; // 1h