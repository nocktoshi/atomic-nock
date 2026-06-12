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
const BID_PREFIX = "bid:";
const BID_FILLED_PREFIX = "bidswap:";
const ETH_IDX = "idx:eth:";
const NOCK_IDX = "idx:nock:";

/** A stored swap record (encoded fields + version), as returned by the Worker. */
export type SwapRecord = Record<string, unknown>;

/** A stored bid (buy order) record, as returned by the Worker. */
export type BidRecord = Record<string, unknown>;

export interface SwapApi {
  /** Create a new swap (seller). `swap` is the encoded swap object. */
  create(swap: Record<string, unknown>): Promise<SwapRecord>;
  /** Buyer commits to an open swap; buyerPkh is taken from the session server-side. */
  claim(hEvm: string, buyerEth: string): Promise<SwapRecord>;
  /** Write a party's progress fields. */
  advance(hEvm: string, fields: Record<string, unknown>): Promise<SwapRecord>;
  /** Read a single swap by id (open read, no auth). Null if not found.
   *  `maxAgeMs` caps how stale a cached record may be — live pollers pass a
   *  value under their poll interval so server-side progress (solver claims,
   *  locks, withdraws) isn't hidden by the default cache TTL. */
  get(hEvm: string, opts?: { maxAgeMs?: number }): Promise<SwapRecord | null>;
  /** List index keys under a prefix (authenticated; server restricts to your own). */
  listKeys(prefix: string): Promise<string[]>;
  /** Marketplace snapshot: open asks + bids in one response (open read, no auth). */
  listFeed(): Promise<{ swaps: SwapRecord[]; bids: BidRecord[] }>;
  /** Either participant cancels a swap while nothing is on-chain. */
  cancel(hEvm: string): Promise<void>;
  /** Create a buy order: pay USDC/wNOCK for native NOCK. */
  createBid(bid: Record<string, unknown>): Promise<BidRecord>;
  /** Read one buy order by id (open read). A filled bid returns
   *  `{ filledHEvm }` pointing at the swap; null once cancelled/expired. */
  getBid(id: string): Promise<BidRecord | null>;
  /** Fill a buy order with a freshly generated swap (filler becomes the seller). */
  fillBid(id: string, swap: Record<string, unknown>): Promise<SwapRecord>;
  /** Creator cancels their own open buy order. */
  cancelBid(id: string): Promise<void>;
}

const CACHE_TTL_MS = 45_000;
const FEED_CACHE_TTL_MS = 10_000;

class HttpSwapApi implements SwapApi {
  constructor(private readonly baseUrl: string) {}

  // Keyed by lowercase hEvm; `at` is the write time so reads can apply their
  // own freshness bound (see SwapApi.get maxAgeMs).
  private readonly _cache = new Map<string, { rec: SwapRecord; at: number }>();
  // Deduplicate concurrent reads for the same key.
  private readonly _inflight = new Map<string, Promise<SwapRecord | null>>();
  private _feedCache: { swaps: SwapRecord[]; bids: BidRecord[]; exp: number } | null = null;
  private _feedInflight: Promise<{ swaps: SwapRecord[]; bids: BidRecord[] }> | null = null;

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
    const rec = json.swap ?? {};
    // Cache the server's response so the next get() sees fresh data immediately.
    if (rec.hEvm) {
      const key = String(rec.hEvm).toLowerCase();
      this._cache.set(key, { rec, at: Date.now() });
      this._inflight.delete(key);
    }
    this._feedCache = null;
    return rec;
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

  async get(hEvm: string, opts?: { maxAgeMs?: number }): Promise<SwapRecord | null> {
    const key = hEvm.toLowerCase();

    // Serve from cache while still fresh (callers can tighten the bound).
    const ttl = Math.min(opts?.maxAgeMs ?? CACHE_TTL_MS, CACHE_TTL_MS);
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.rec;

    // Deduplicate concurrent requests for the same key.
    let p = this._inflight.get(key);
    if (!p) {
      p = this._fetchSwap(key).finally(() => this._inflight.delete(key));
      this._inflight.set(key, p);
    }
    return p;
  }

  private async _fetchSwap(key: string): Promise<SwapRecord | null> {
    const res = await fetch(`${this.baseUrl}/swap/${encodeURIComponent(key)}`);
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
    const rec = (await res.json()) as SwapRecord;
    this._cache.set(key, { rec, at: Date.now() });
    return rec;
  }
  private async fetchFeed(): Promise<{ swaps: SwapRecord[]; bids: BidRecord[] }> {
    if (this._feedCache && Date.now() < this._feedCache.exp) {
      return { swaps: this._feedCache.swaps, bids: this._feedCache.bids };
    }
    if (!this._feedInflight) {
      this._feedInflight = (async () => {
        const res = await fetch(`${this.baseUrl}/feed`);
        if (!res.ok) throw new Error(`feed failed (${res.status})`);
        const json = (await res.json()) as { swaps?: SwapRecord[]; bids?: BidRecord[] };
        const swaps = json.swaps ?? [];
        const bids = json.bids ?? [];
        this._feedCache = { swaps, bids, exp: Date.now() + FEED_CACHE_TTL_MS };
        return { swaps, bids };
      })().finally(() => {
        this._feedInflight = null;
      });
    }
    return this._feedInflight;
  }

  async listFeed(): Promise<{ swaps: SwapRecord[]; bids: BidRecord[] }> {
    return this.fetchFeed();
  }

  async cancel(hEvm: string): Promise<void> {
    await this.post(`/swap/${encodeURIComponent(hEvm)}/cancel`, {});
  }

  async createBid(bid: Record<string, unknown>): Promise<BidRecord> {
    const token = await ensureSession(this.baseUrl);
    const res = await fetch(`${this.baseUrl}/bid`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ bid }),
    });
    const json = (await res.json().catch(() => ({}))) as { bid?: BidRecord; error?: string };
    if (!res.ok) throw new Error(json.error || `bid create failed (${res.status})`);
    this._feedCache = null;
    return json.bid ?? {};
  }

  async getBid(id: string): Promise<BidRecord | null> {
    const res = await fetch(`${this.baseUrl}/bid/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`bid read failed (${res.status})`);
    return (await res.json()) as BidRecord;
  }

  fillBid(id: string, swap: Record<string, unknown>): Promise<SwapRecord> {
    return this.post(`/bid/${encodeURIComponent(id)}/fill`, { swap });
  }

  async cancelBid(id: string): Promise<void> {
    await this.post(`/bid/${encodeURIComponent(id)}/cancel`, {});
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
  async listFeed(): Promise<{ swaps: SwapRecord[]; bids: BidRecord[] }> {
    const [swaps, bids] = await Promise.all([this.listOpenSwaps(), this.listBidsLocal()]);
    return { swaps, bids };
  }

  private async listOpenSwaps(): Promise<SwapRecord[]> {
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
    if (rec.lockFirstName || rec.nockLockTxId || rec.usdcLockTxHash) {
      throw new Error("funds already locked — refund instead of cancelling");
    }
    await this.kv.delete(SWAP_PREFIX + this.id(hEvm));
  }

  async createBid(bid: Record<string, unknown>): Promise<BidRecord> {
    const id = crypto.randomUUID().replace(/-/g, "");
    const rec = {
      ...bid,
      id,
      creatorPkh: bid.creatorPkh ?? getActiveWallet()?.pkh ?? "dev-bidder",
      createdAt: Math.floor(Date.now() / 1000),
      version: 1,
    };
    await this.kv.put(BID_PREFIX + id, JSON.stringify(rec));
    return rec;
  }

  private async listBidsLocal(): Promise<BidRecord[]> {
    const keys = await this.kv.list(BID_PREFIX);
    const bids = await Promise.all(
      keys.map(async (k) => {
        const raw = await this.kv.get(k);
        return raw ? (JSON.parse(raw) as BidRecord) : null;
      })
    );
    return bids
      .filter((b): b is BidRecord => b !== null)
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  }

  async getBid(id: string): Promise<BidRecord | null> {
    const raw = await this.kv.get(BID_PREFIX + id);
    if (raw) return JSON.parse(raw) as BidRecord;
    const hEvm = await this.kv.get(BID_FILLED_PREFIX + id);
    return hEvm ? { filledHEvm: hEvm } : null;
  }

  async fillBid(id: string, swap: Record<string, unknown>): Promise<SwapRecord> {
    const raw = await this.kv.get(BID_PREFIX + id);
    if (!raw) throw new Error("bid not found (already filled or cancelled?)");
    const bid = JSON.parse(raw) as BidRecord;
    // Mirror the worker: economic identity is forced from the bid.
    const rec = await this.create({
      ...swap,
      buyerPkh: bid.creatorPkh,
      buyerEth: bid.creatorEth,
      token: bid.token,
      usdcAmount: bid.quoteAmount,
      nockGift: bid.nockGift,
    });
    await this.kv.delete(BID_PREFIX + id);
    await this.kv.put(BID_FILLED_PREFIX + id, String(rec.hEvm).toLowerCase());
    return rec;
  }

  async cancelBid(id: string): Promise<void> {
    await this.kv.delete(BID_PREFIX + id);
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
