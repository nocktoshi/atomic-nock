import type { KvStore } from "./kv.js";

/**
 * KvStore backed by the minimal Cloudflare Worker in `workers/kv`. Reads/list are
 * open (values are non-secret swap metadata); writes carry a shared bearer token.
 *
 * NEVER store secrets (the seller preimage) here — see SecretStore.
 */
export class CloudflareKvStore implements KvStore {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private authHeaders(): HeadersInit {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async get(key: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get failed (${res.status})`);
    return res.text();
  }

  async put(key: string, value: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: this.authHeaders(),
      body: value,
    });
    if (!res.ok) throw new Error(`KV put failed (${res.status})`);
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`KV delete failed (${res.status})`);
    }
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
