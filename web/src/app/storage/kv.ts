/**
 * Minimal key-value abstraction. All swap persistence goes through this so the
 * backend can be swapped (in-memory → Cloudflare KV → anything) without touching
 * the repository or UI. Values are opaque strings (we store swap JSON).
 *
 * `list(prefix)` returns matching KEYS (not values) — both Cloudflare KV and the
 * in-memory adapter support prefix listing, which is how we index swaps by address.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
