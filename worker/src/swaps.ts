/**
 * Swap operations — thin client over the Market Durable Object (market.ts),
 * which owns the state machine and runs every mutation atomically. This module
 * keeps the original function surface so routes stay unchanged.
 *
 * KV (env.SWAPS) is NO LONGER used for swaps/bids/feed/solver state — it
 * remains only for user-scoped data (profiles, telegram links, email codes,
 * push subscriptions), which is latency-insensitive and naturally key-value.
 */
import type { SwapRecord } from "./contract.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Market } from "./market-do.js";

export interface Env {
  SWAPS: KVNamespace;
  SESSION_SECRET?: string;
  KV_TOKEN?: string; // server-only admin secret (never shipped to the browser)
  /** Rate limiters (wrangler.toml [[ratelimits]]); optional so dev/tests skip them. */
  RL_READ?: RateLimiter;
  RL_WRITE?: RateLimiter;
  RL_AUTH?: RateLimiter;
  /** Per-pkh budget for the AUTHENTICATED solver's polling — without it the
   *  bot's reads exhaust the anonymous per-IP bucket and starve browsers
   *  (locally they even share 127.0.0.1, stalling RFQs). */
  RL_SOLVER?: RateLimiter;
  /** Market Durable Object — the strongly-consistent system of record for
   *  swaps, bids, RFQs, and solver state (KV is eventually consistent and
   *  transactionless; see market.ts). */
  MARKET_DO?: DurableObjectNamespace<Market>;
  /** Telegram notifications (secrets via `wrangler secret put`). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Bot username (var, not secret) for the t.me deep link, e.g. "AtomicNockBot". */
  TELEGRAM_BOT_NAME?: string;
  /** Web Push VAPID keys (public+subject are vars; private via `wrangler secret put`). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Email via Resend (key is a secret; from-address is a var). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Site base URL for notification deep links (default https://atomicnock.com). */
  APP_URL?: string;
  /** NEAR Intents 1Click. JWT is a SECRET (distribution-channel; removes the
   *  0.2% platform fee) — kept server-side so the browser never sees it. */
  ONECLICK_JWT?: string;
  ONECLICK_URL?: string; // default https://1click.chaindefuser.com
  /** App-fee revenue (vars): a NEAR account + bps injected into every quote. */
  ONECLICK_APPFEE_RECIPIENT?: string;
  ONECLICK_APPFEE_BPS?: string;
  /** Comma-separated pkhs allowed to publish a solver quote (empty = any session). */
  SOLVER_PKHS?: string;
}

export { SwapError } from "./errors.js";

import { withMarket } from "./market-client.js";

export async function loadSwap(env: Env, hEvm: string): Promise<SwapRecord | null> {
  return withMarket(env, (stub) => stub.loadSwap(hEvm));
}

export async function createSwap(
  env: Env,
  swap: Record<string, unknown>,
  sessionPkh: string
): Promise<SwapRecord> {
  return withMarket(env, (stub) => stub.createSwap(swap, sessionPkh));
}

export async function claimSwap(
  env: Env,
  hEvm: string,
  buyerEth: string,
  sessionPkh: string
): Promise<SwapRecord> {
  return withMarket(env, (stub) => stub.claimSwap(hEvm, buyerEth, sessionPkh));
}

export async function cancelSwap(env: Env, hEvm: string, sessionPkh: string): Promise<void> {
  await withMarket(env, (stub) => stub.cancelSwap(hEvm, sessionPkh));
}

export async function advanceSwap(
  env: Env,
  hEvm: string,
  fields: Record<string, unknown>,
  sessionPkh: string,
  expectedVersion?: number
): Promise<SwapRecord> {
  return withMarket(env, (stub) => stub.advanceSwap(hEvm, fields, sessionPkh, expectedVersion));
}

/** Every swap id a pkh participates in (replaces the KV idx:nock listing). */
export async function listMySwapIds(env: Env, pkh: string): Promise<string[]> {
  return withMarket(env, (stub) => stub.listMine(pkh));
}
