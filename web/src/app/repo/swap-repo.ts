import type { Hex } from "viem";
import {
  encodeSwapParams,
  decodeSwapParams,
  type SwapPublic,
} from "../../swap.js";
import { getKvStore, type KvStore } from "../storage/index.js";

const SWAP_PREFIX = "swap:";
const ETH_IDX = "idx:eth:";
const NOCK_IDX = "idx:nock:";

/**
 * Persistence for swap metadata, keyed by `hEvm` (the swap id). Maintains
 * prefix-based secondary indexes so swaps can be listed by any participant
 * address — both legs of every party (seller/buyer × eth/nock).
 *
 * One `put` replaces all the old scattered localStorage `save*Json` calls.
 */
export class SwapRepository {
  constructor(private readonly kv: KvStore) {}

  async get(hEvm: string): Promise<SwapPublic | null> {
    const raw = await this.kv.get(SWAP_PREFIX + hEvm.toLowerCase());
    return raw ? decodeSwapParams(raw) : null;
  }

  async put(swap: SwapPublic): Promise<void> {
    const id = swap.hEvm.toLowerCase();
    await this.kv.put(SWAP_PREFIX + id, encodeSwapParams(swap));
    const idxKeys: string[] = [];
    if (swap.sellerEth) idxKeys.push(`${ETH_IDX}${swap.sellerEth.toLowerCase()}:${id}`);
    if (swap.buyerEth) idxKeys.push(`${ETH_IDX}${swap.buyerEth.toLowerCase()}:${id}`);
    if (swap.sellerPkh) idxKeys.push(`${NOCK_IDX}${swap.sellerPkh}:${id}`);
    if (swap.buyerPkh) idxKeys.push(`${NOCK_IDX}${swap.buyerPkh}:${id}`);
    await Promise.all(idxKeys.map((k) => this.kv.put(k, id)));
  }

  listForAddress(addr: string): Promise<SwapPublic[]> {
    return this.listByPrefix(`${ETH_IDX}${addr.toLowerCase()}:`);
  }

  listForNockPkh(pkh: string): Promise<SwapPublic[]> {
    return this.listByPrefix(`${NOCK_IDX}${pkh}:`);
  }

  private async listByPrefix(prefix: string): Promise<SwapPublic[]> {
    const keys = await this.kv.list(prefix);
    const swaps = await Promise.all(
      keys.map((k) => this.get(k.slice(prefix.length) as Hex))
    );
    return swaps.filter((s): s is SwapPublic => s !== null);
  }
}

let instance: SwapRepository | null = null;

export function getSwapRepository(): SwapRepository {
  if (!instance) instance = new SwapRepository(getKvStore());
  return instance;
}

/** Test seam. */
export function setSwapRepository(repo: SwapRepository): void {
  instance = repo;
}
