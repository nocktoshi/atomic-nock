import type { Address } from "viem";
import { base } from "viem/chains";
import { readEnv, isProd } from "./env.js";

export const NOCK_GRPC_UPSTREAM =
  readEnv("VITE_NOCK_GRPC_UPSTREAM") ?? "https://rpc.nockchain.net";

export const CHAIN = base;
export const CHAIN_ID = Number(readEnv("VITE_CHAIN_ID") ?? base.id);

/** Ethereum mainnet RPC for ENS lookups. Must allow browser CORS. The viem
 *  default (eth.merkle.io) does not, so we default to a CORS-friendly endpoint. */
export const ETH_RPC_URL = (
  readEnv("VITE_ETH_RPC_URL") ?? "https://ethereum-rpc.publicnode.com"
).trim();

export const USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

export const HTLC_ADDRESS = (readEnv("VITE_HTLC_ADDRESS") ??
  "0x5ac37e7A63b107d226d0b88129B8EB8b07172B75") as Address;

/** Wrapped NOCK on Base (symbol "NOCK" on-chain; shown as "wNOCK" in the UI). */
export const WNOCK_ADDRESS =
  "0x9B5E262cF9bb04869ab40b19AF91D2dc85761722" as Address;

/** HTLC instance for wNOCK swaps. Empty until deployed — wNOCK is hidden in the UI. */
export const WNOCK_HTLC_ADDRESS = (
  readEnv("VITE_HTLC_ADDRESS_WNOCK") ?? "0x606b807C32F15D28EB612eecB2A1603399a66545"
).trim() as Address | "";

// --- Quote-token registry ------------------------------------------------------
// The Base leg of a swap pays one of these tokens. Swap records carry an optional
// `token` key; absent means USDC (every swap created before multi-asset support).
// The `usdc*` field names on SwapPublic are wire-stable and mean "the Base
// quote-asset leg" regardless of token.

export type TokenKey = "USDC" | "WNOCK";

export interface TokenInfo {
  key: TokenKey;
  /** ERC20 contract on Base. */
  address: Address;
  /** AtomicNock HTLC instance for this token ("" = not deployed yet). */
  htlc: Address | "";
  /** UI label (wNOCK's on-chain symbol is literally "NOCK"; we disambiguate). */
  symbol: string;
  /** "usd" prices as $/NOCK; "nock" prices as a wNOCK/NOCK ratio. */
  kind: "usd" | "nock";
}

export const TOKENS: Record<TokenKey, TokenInfo> = {
  USDC: { key: "USDC", address: USDC_ADDRESS, htlc: HTLC_ADDRESS, symbol: "USDC", kind: "usd" },
  WNOCK: { key: "WNOCK", address: WNOCK_ADDRESS, htlc: WNOCK_HTLC_ADDRESS, symbol: "wNOCK", kind: "nock" },
};

/** Resolve a swap's quote token; absent/unknown ⇒ USDC (pre-multi-asset records). */
export function tokenInfo(token?: string): TokenInfo {
  return TOKENS[(token ?? "USDC") as TokenKey] ?? TOKENS.USDC;
}

/** Swap API base URL (the Worker). Empty in dev = in-memory store (not durable). */
const kvFromEnv = (readEnv("VITE_KV_URL") ?? "").trim();
export const KV_URL =
  kvFromEnv || (isProd() ? "https://api.atomicnock.com" : "");

/** VAPID public key for browser push (base64url). Empty = push hidden in the UI.
 *  Generate a pair with: npx web-push generate-vapid-keys */
export const VAPID_PUBLIC_KEY = (readEnv("VITE_VAPID_PUBLIC_KEY") ?? "").trim();

/** Market price feed (NOCK/USD). Empty in dev = price hidden. */
const priceFromEnv = (readEnv("VITE_PRICE_URL") ?? "").trim();
export const PRICE_URL =
  priceFromEnv ||
  (isProd()
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

/** Minimum NOCK in any swap leg — must cover the on-chain lock/claim fee. */
export const MIN_NOCK_AMOUNT = 50;
export const MIN_NOCK_NICKS = BigInt(MIN_NOCK_AMOUNT * 65536);

/** USDC window for SOLVER-facing sell orders. Deliberately SHORT: once the
 *  solver locks USDC, the remaining window is the seller's free option (execute
 *  if NOCK fell, abandon if it pumped) — its value scales with √time, so a 2h
 *  window is ~2.5× cheaper to write than the 12h OTC default. Must stay above
 *  the worker's 1h open-ask pruning threshold + the solver's min-window gate. */
export const SOLVER_ASK_WINDOW_SEC = 2 * 3600; // 2h