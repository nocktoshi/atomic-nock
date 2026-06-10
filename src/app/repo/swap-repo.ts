import type { Hex } from "viem";
import {
  encodeSwapParams,
  decodeSwapParams,
  type SwapPublic,
  type DraftSwap,
} from "../../swap.js";
import { getKvStore, type KvStore } from "../storage/index.js";
import { getSwapApi, type SwapApi } from "./swap-api.js";
import { getActiveWallet } from "../auth.js";
import { progressFields } from "../swap-fields.js";

const SWAP_PREFIX = "swap:";
const ETH_IDX = "idx:eth:";
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
 * Persistence for swap metadata, keyed by `hEvm` (the swap id). Maintains
 * prefix-based secondary indexes so swaps can be listed by any participant
 * address — both legs of every party (seller/buyer × eth/nock).
 *
 * One `put` replaces all the old scattered localStorage `save*Json` calls.
 */
export class SwapRepository {
  constructor(
    private readonly kv: KvStore,
    private readonly api: SwapApi
  ) {}

  async get(hEvm: string): Promise<SwapPublic | null> {
    const raw = await this.kv.get(SWAP_PREFIX + hEvm.toLowerCase());
    return raw ? decodeSwapParams(raw) : null;
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

  listForAddress(addr: string): Promise<SwapPublic[]> {
    return this.listByPrefix(`${ETH_IDX}${addr.toLowerCase()}:`);
  }

  listForNockPkh(pkh: string): Promise<SwapPublic[]> {
    return this.listByPrefix(`${NOCK_IDX}${pkh}:`);
  }

  private async listByPrefix(prefix: string): Promise<SwapPublic[]> {
    // Listing is authenticated and server-scoped to the caller's own pkh.
    const keys = await this.api.listKeys(prefix);
    const swaps = await Promise.all(
      keys.map((k) => this.get(k.slice(prefix.length) as Hex))
    );
    return swaps.filter((s): s is SwapPublic => s !== null);
  }
}

let instance: SwapRepository | null = null;

export function getSwapRepository(): SwapRepository {
  if (!instance) instance = new SwapRepository(getKvStore(), getSwapApi());
  return instance;
}

/** Test seam. */
export function setSwapRepository(repo: SwapRepository): void {
  instance = repo;
}
