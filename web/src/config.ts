import type { Address } from "viem";
import { base } from "viem/chains";

/** Set explicitly to override; empty = same-origin Vite proxy in dev or public RPC. */
export const ENVOY_URL = (import.meta.env.VITE_ENVOY_URL ?? "").trim();

export const NOCK_GRPC_UPSTREAM =
  import.meta.env.VITE_NOCK_GRPC_UPSTREAM ?? "https://rpc.nockchain.net";

export const CHAIN = base;
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? base.id);

export const USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

export const HTLC_ADDRESS = (import.meta.env.VITE_HTLC_ADDRESS ?? "") as Address;

/** Cloudflare KV worker base URL. Empty = in-memory store (dev/tests, not durable). */
export const KV_URL = (import.meta.env.VITE_KV_URL ?? "").trim();

/** Shared bearer token gating writes to the KV worker (matches the worker's KV_TOKEN). */
export const KV_TOKEN = (import.meta.env.VITE_KV_TOKEN ?? "").trim();

/** Market price feed (NOCK/USD). Empty = price hidden. */
export const PRICE_URL = (import.meta.env.VITE_PRICE_URL ?? "").trim();

/** Default Nock refund blocks after current height (seller reclaim path). */
export const DEFAULT_NOCK_REFUND_DELTA = 500n;

/** USDC timelock seconds from now (buyer refund); should be > Nock refund window. */
export const DEFAULT_USDC_TIMEOUT_SEC = 86_400; // 24h