import type { Hex } from "viem";
import {
  encodeSwapParams,
  decodeSwapParams,
  type SwapPublic,
  type DraftSwap,
} from "../../swap.js";
import { getSwapApi, type SwapApi } from "./swap-api.js";
import { getActiveWallet } from "../auth.js";
import { progressFields } from "../swap-fields.js";

const NOCK_IDX = "idx:nock:";

/** Encoded (string-bigint) form of a swap, as stored/transported. */
function encoded(swap: DraftSwap): Record<string, unknown> {
  return JSON.parse(encodeSwapParams(swap as SwapPublic)) as Record<string, unknown>;
}

/** Determine which party the connected wallet is for a swap. */
function roleFor(swap: DraftSwap): "seller" | "buyer" {
  const pkh = getActiveWallet()?.pkh;
  if (pkh && swap.sellerPkh === pkh) return "seller";
  if (pkh && swap.buyerPkh === pkh) return "buyer";
  throw new Error("Connect the wallet that owns this swap to update it");
}

/**
 * Persistence for swap metadata, keyed by `hEvm` (the swap id). Listing goes
 * through the authenticated, server-scoped `idx:nock:<pkh>:` index, which covers
 * every swap you're part of (as buyer or seller); the eth index is not listable.
 *
 * One `put` replaces all the old scattered localStorage `save*Json` calls.
 */
export class SwapRepository {
  constructor(private readonly api: SwapApi) {}

  async get(hEvm: string): Promise<SwapPublic | null> {
    // GET /swap/:id endpoint
    const rec = await this.api.get(hEvm);
    return rec ? decodeSwapParams(JSON.stringify(rec)) : null;
  }

  /** Create a new (possibly open / buyer-less) swap. Seller-authenticated. */
  async create(swap: DraftSwap): Promise<void> {
    await this.api.create(encoded(swap));
  }

  /** Buyer commits to an open swap; buyerPkh comes from the signed-in session.
   *  Returns the committed swap so callers avoid KV read-lag. */
  async claim(hEvm: string, buyerEth: string): Promise<SwapPublic> {
    const rec = await this.api.claim(hEvm, buyerEth);
    return decodeSwapParams(JSON.stringify(rec));
  }

  /** Persist a party's progress fields (signed write, server-validated). */
  async put(swap: DraftSwap): Promise<void> {
    if (!swap.hEvm) throw new Error("swap has no id yet");
    const role = roleFor(swap);
    await this.api.advance(swap.hEvm, progressFields(encoded(swap), role));
  }

  listForNockPkh(pkh: string): Promise<SwapPublic[]> {
    return this.listByPrefix(`${NOCK_IDX}${pkh}:`);
  }

  /** Marketplace: open swaps anyone can browse (no auth needed). */
  async listOpen(): Promise<SwapPublic[]> {
    const recs = await this.api.listOpen();
    return recs.map((r) => decodeSwapParams(JSON.stringify(r)));
  }

  /** Seller cancels their own unclaimed open swap (removes it everywhere). */
  cancel(hEvm: string): Promise<void> {
    return this.api.cancel(hEvm);
  }

  private async listByPrefix(prefix: string): Promise<SwapPublic[]> {
    const keys = await this.api.listKeys(prefix);
    // Fetch in small batches so a large swap list doesn't fire dozens of
    // simultaneous requests and hit the read rate limit (60/min/IP).
    const BATCH = 5;
    const swaps: (SwapPublic | null)[] = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const results = await Promise.all(
        keys.slice(i, i + BATCH).map((k) => this.get(k.slice(prefix.length) as Hex))
      );
      swaps.push(...results);
    }
    return swaps.filter((s): s is SwapPublic => s !== null);
  }
}

let instance: SwapRepository | null = null;

export function getSwapRepository(): SwapRepository {
  if (!instance) instance = new SwapRepository(getSwapApi());
  return instance;
}

/** Test seam. */
export function setSwapRepository(repo: SwapRepository): void {
  instance = repo;
}
