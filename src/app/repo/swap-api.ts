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
  /** List index keys under a prefix (authenticated; server restricts to your own). */
  listKeys(prefix: string): Promise<string[]>;
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
  async listKeys(prefix: string): Promise<string[]> {
    const token = await ensureSession(this.baseUrl);
    const res = await fetch(`${this.baseUrl}/list?prefix=${encodeURIComponent(prefix)}`, {
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
    const json = (await res.json()) as { keys?: string[] };
    return json.keys ?? [];
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
    const rec = { ...swap, version: 1 };
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
