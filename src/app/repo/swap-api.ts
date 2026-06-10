/**
 * Authenticated client for the Worker's semantic swap endpoints. Writes carry a
 * session bearer token (signed in on demand). Reads stay on the open KvStore.
 *
 * In dev (no VITE_KV_URL) a MemorySwapApi mimics the Worker against the in-memory
 * KvStore so the flow works without a deployed worker or sign-in.
 */
import { KV_URL } from "../../config.js";
import { ensureSession, getActiveWallet } from "../auth.js";
import { getKvStore, type KvStore } from "../storage/index.js";

const SWAP_PREFIX = "swap:";
const ETH_IDX = "idx:eth:";
const NOCK_IDX = "idx:nock:";

/** A stored swap record (encoded fields + version), as returned by the Worker. */
export type SwapRecord = Record<string, unknown>;

export interface SwapApi {
  /** Create a new swap (seller). `swap` is the encoded swap object. */
  create(swap: Record<string, unknown>): Promise<SwapRecord>;
  /** Buyer commits to an open swap; buyerPkh is taken from the session server-side. */
  claim(hEvm: string, buyerEth: string): Promise<SwapRecord>;
  /** Write a party's progress fields. */
  advance(hEvm: string, fields: Record<string, unknown>): Promise<SwapRecord>;
  /** Read a single swap by id (open read, no auth). Null if not found. */
  get(hEvm: string): Promise<SwapRecord | null>;
  /** List index keys under a prefix (authenticated; server restricts to your own). */
  listKeys(prefix: string): Promise<string[]>;
  /** Marketplace: open (buyer-less) swaps, newest first (open read, no auth). */
  listOpen(): Promise<SwapRecord[]>;
  /** Seller cancels their own unclaimed open swap. */
  cancel(hEvm: string): Promise<void>;
}

class HttpSwapApi implements SwapApi {
  constructor(private readonly baseUrl: string) {}

  private async post(path: string, body: unknown): Promise<SwapRecord> {
    const token = await ensureSession(this.baseUrl);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "";
      try {
        msg = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(msg || `request failed (${res.status})`);
    }
    const json = (await res.json()) as { swap?: SwapRecord };
    return json.swap ?? {};
  }

  create(swap: Record<string, unknown>): Promise<SwapRecord> {
    return this.post("/swap", { swap });
  }
  claim(hEvm: string, buyerEth: string): Promise<SwapRecord> {
    return this.post(`/swap/${encodeURIComponent(hEvm)}/claim`, { buyerEth });
  }
  advance(hEvm: string, fields: Record<string, unknown>): Promise<SwapRecord> {
    return this.post(`/swap/${encodeURIComponent(hEvm)}/advance`, { fields });
  }
  async get(hEvm: string): Promise<SwapRecord | null> {
    // Open read — the worker serves the record at GET /swap/:id (bare id; it
    // prepends the `swap:` key prefix itself). 404 means no such swap.
    const res = await fetch(`${this.baseUrl}/swap/${encodeURIComponent(hEvm.toLowerCase())}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      let msg = "";
      try {
        msg = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(msg || `swap read failed (${res.status})`);
    }
    return (await res.json()) as SwapRecord;
  }
  async listOpen(): Promise<SwapRecord[]> {
    // Public marketplace read — follow cursors up to a sane cap.
    const out: SwapRecord[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 4; // 4 × 50 swaps
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`${this.baseUrl}/open?${qs}`);
      if (!res.ok) throw new Error(`marketplace list failed (${res.status})`);
      const json = (await res.json()) as {
        swaps?: SwapRecord[];
        cursor?: string;
        complete?: boolean;
      };
      out.push(...(json.swaps ?? []));
      if (json.complete !== false || !json.cursor) break;
      cursor = json.cursor;
    }
    return out;
  }

  async cancel(hEvm: string): Promise<void> {
    await this.post(`/swap/${encodeURIComponent(hEvm)}/cancel`, {});
  }

  async listKeys(prefix: string): Promise<string[]> {
    const token = await ensureSession(this.baseUrl);
    // The worker pages with a KV cursor; follow it up to a sane cap so one
    // pathological prefix can't loop forever.
    const out: string[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 5; // 5 × 100 keys
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = new URLSearchParams({ prefix });
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`${this.baseUrl}/list?${qs}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let msg = "";
        try {
          msg = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          /* ignore */
        }
        throw new Error(msg || `list failed (${res.status})`);
      }
      const json = (await res.json()) as {
        keys?: string[];
        cursor?: string;
        complete?: boolean;
      };
      out.push(...(json.keys ?? []));
      if (json.complete !== false || !json.cursor) break;
      cursor = json.cursor;
    }
    return out;
  }
}

/** Dev/test: mimic the Worker against an in-memory KvStore (no auth). */
export class MemorySwapApi implements SwapApi {
  constructor(private readonly kv: KvStore) {}

  private id(hEvm: string): string {
    return hEvm.toLowerCase();
  }

  private async load(hEvm: string): Promise<Record<string, unknown> | null> {
    const raw = await this.kv.get(SWAP_PREFIX + this.id(hEvm));
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  get(hEvm: string): Promise<SwapRecord | null> {
    return this.load(hEvm);
  }

  private async write(rec: Record<string, unknown>): Promise<void> {
    const key = this.id(rec.hEvm as string);
    await this.kv.put(SWAP_PREFIX + key, JSON.stringify(rec));
    const idx: string[] = [];
    if (rec.sellerEth) idx.push(`${ETH_IDX}${String(rec.sellerEth).toLowerCase()}:${key}`);
    if (rec.buyerEth) idx.push(`${ETH_IDX}${String(rec.buyerEth).toLowerCase()}:${key}`);
    if (rec.sellerPkh) idx.push(`${NOCK_IDX}${rec.sellerPkh}:${key}`);
    if (rec.buyerPkh) idx.push(`${NOCK_IDX}${rec.buyerPkh}:${key}`);
    await Promise.all(idx.map((k) => this.kv.put(k, key)));
  }

  async create(swap: Record<string, unknown>): Promise<SwapRecord> {
    // Mirror the worker: stamp createdAt server-side (here: locally).
    const rec = { ...swap, createdAt: Math.floor(Date.now() / 1000), version: 1 };
    await this.write(rec);
    return rec;
  }
  async claim(hEvm: string, buyerEth: string): Promise<SwapRecord> {
    const rec = await this.load(hEvm);
    if (!rec) throw new Error("swap not found");
    if (rec.buyerPkh || rec.buyerEth) throw new Error("swap already claimed");
    rec.buyerPkh = getActiveWallet()?.pkh ?? rec.buyerPkh;
    rec.buyerEth = buyerEth;
    rec.version = ((rec.version as number) ?? 1) + 1;
    await this.write(rec);
    return rec;
  }
  async advance(hEvm: string, fields: Record<string, unknown>): Promise<SwapRecord> {
    const rec = await this.load(hEvm);
    if (!rec) throw new Error("swap not found");
    Object.assign(rec, fields);
    rec.version = ((rec.version as number) ?? 1) + 1;
    await this.write(rec);
    return rec;
  }
  listKeys(prefix: string): Promise<string[]> {
    return this.kv.list(prefix);
  }
  async listOpen(): Promise<SwapRecord[]> {
    const keys = await this.kv.list(SWAP_PREFIX);
    const swaps = await Promise.all(
      keys.map((k) => this.load(k.slice(SWAP_PREFIX.length)))
    );
    return swaps
      .filter((s): s is SwapRecord => !!s && !s.buyerPkh && !s.buyerEth)
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  }
  async cancel(hEvm: string): Promise<void> {
    const rec = await this.load(hEvm);
    if (!rec) throw new Error("swap not found");
    if (rec.buyerPkh || rec.buyerEth) throw new Error("swap already claimed");
    await this.kv.delete(SWAP_PREFIX + this.id(hEvm));
  }
}

let instance: SwapApi | null = null;

export function getSwapApi(): SwapApi {
  if (!instance) {
    instance = KV_URL ? new HttpSwapApi(KV_URL) : new MemorySwapApi(getKvStore());
  }
  return instance;
}

/** Test seam. */
export function setSwapApi(api: SwapApi): void {
  instance = api;
}
