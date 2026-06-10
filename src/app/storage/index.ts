import type { KvStore } from "./kv.js";
import { MemoryKvStore } from "./memory-kv.js";

export type { KvStore } from "./kv.js";
export { MemoryKvStore } from "./memory-kv.js";

let instance: KvStore | null = null;

/**
 * The app's KvStore. It now backs only the dev/test `MemorySwapApi` — in
 * production all reads and writes go through the authenticated `HttpSwapApi`
 * (see swap-api.ts), which is selected whenever `VITE_KV_URL` is set, so this is
 * only reached in local dev and is always the in-memory adapter.
 */
export function getKvStore(): KvStore {
  if (!instance) instance = new MemoryKvStore();
  return instance;
}

/** Test/seam hook: override the active store. */
export function setKvStore(store: KvStore): void {
  instance = store;
}
