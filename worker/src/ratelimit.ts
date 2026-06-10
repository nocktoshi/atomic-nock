/**
 * Basic abuse protection via Workers native rate-limiting bindings (configured
 * in wrangler.toml [[ratelimits]]). Per-colo and approximate — fine as a basic
 * brake, deliberately NOT Cloudflare WAF and NOT KV counters (KV is eventually
 * consistent and write-rate-limited, the wrong tool for counting).
 *
 * Bindings are optional in Env so local dev / vitest (no binding) skip limiting.
 */
import { SwapError } from "./swaps.js";

/** Shape of a Workers rate-limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Throw 429 when the key is over its limit. A missing binding or a limiter
 * failure never blocks the request — rate limiting must not take the API down.
 */
export async function enforceRate(
  limiter: RateLimiter | undefined,
  key: string
): Promise<void> {
  if (!limiter) return;
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key });
  } catch {
    return;
  }
  if (!result.success) {
    throw new SwapError(429, "too many requests — slow down and retry in a minute");
  }
}
