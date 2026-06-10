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
  "0xD347AC30A11abe63e92CFcb2285dC770FF0F7236") as Address;

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

/** Default Nock refund blocks after current height (seller reclaim path). */
export const DEFAULT_NOCK_REFUND_DELTA = 500n;

/** USDC timelock seconds from now (buyer refund); should be > Nock refund window. */
export const DEFAULT_USDC_TIMEOUT_SEC = 86_400; // 24h