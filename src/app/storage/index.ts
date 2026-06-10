import { KV_URL } from "../../config.js";
import type { KvStore } from "./kv.js";
import { MemoryKvStore } from "./memory-kv.js";
import { CloudflareKvStore } from "./cloudflare-kv.js";

export type { KvStore } from "./kv.js";
export { MemoryKvStore } from "./memory-kv.js";
export { CloudflareKvStore } from "./cloudflare-kv.js";

let instance: KvStore | null = null;

/**
 * The app's KvStore. Uses Cloudflare KV when VITE_KV_URL is set (required for
 * production). Falls back to in-memory for local dev/tests (not durable, warns on
 * first use).
 */
export function getKvStore(): KvStore {
  if (!instance) {
    if (KV_URL) {
      // Reads only — writes go through the authenticated SwapApi (swap-api.ts).
      instance = new CloudflareKvStore(KV_URL);
    } else {
      if (import.meta.env.DEV) {
        console.warn(
          "⚠️  VITE_KV_URL not set — using in-memory storage (ephemeral, not durable). " +
            "Set VITE_KV_URL to a Cloudflare KV worker for production."
        );
      }
      instance = new MemoryKvStore();
    }
  }
  return instance;
}

/** Test/seam hook: override the active store. */
export function setKvStore(store: KvStore): void {
  instance = store;
}
