import type { KvStore } from "./kv.js";

/**
 * In-memory KvStore. Used by tests and as the dev fallback when no KV worker is
 * configured. Not durable across reloads — that's intentional; durable storage is
 * the Cloudflare adapter's job.
 */
export class MemoryKvStore implements KvStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}
