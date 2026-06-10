import type { KvStore } from "./kv.js";

/**
 * KvStore backed by the minimal Cloudflare Worker in `workers/kv`. Reads/list are
 * open (values are non-secret swap metadata); writes carry a shared bearer token.
 *
 * NEVER store secrets (the seller preimage) here — see SecretStore.
 */
export class CloudflareKvStore implements KvStore {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async get(key: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get failed (${res.status})`);
    return res.text();
  }

  // Writes are no longer raw KV puts — they go through the authenticated
  // SwapApi (create/claim/advance). These throw to catch any stray caller.
  async put(): Promise<void> {
    throw new Error("direct KV writes are disabled — use the SwapApi");
  }

  async delete(): Promise<void> {
    throw new Error("direct KV deletes are disabled — use the SwapApi");
  }

  async list(prefix: string): Promise<string[]> {
    const res = await fetch(
      `${this.baseUrl}/list?prefix=${encodeURIComponent(prefix)}`
    );
    if (!res.ok) throw new Error(`KV list failed (${res.status})`);
    const body = (await res.json()) as { keys?: string[] };
    return body.keys ?? [];
  }
}
