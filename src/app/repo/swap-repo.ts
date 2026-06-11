import type { Address, Hex } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import {
  encodeSwapParams,
  decodeSwapParams,
  type SwapPublic,
  type DraftSwap,
} from "../../swap.js";
import type { TokenKey } from "../../config.js";
import { getSwapApi, type SwapApi, type BidRecord } from "./swap-api.js";
import { getActiveWallet } from "../auth.js";
import { progressFields } from "../swap-fields.js";

/**
 * A buy order: the creator pays `quoteAmount` of `token` on Base for `nockGift`
 * nicks of native NOCK. No hashlock yet — the FILLER generates the secret and
 * the bid converts into a normal swap (filler = seller, creator = buyer).
 */
export interface BidPublic {
  id: string;
  creatorPkh: Digest;
  creatorEth: Address;
  token: TokenKey;
  quoteAmount: string;
  nockGift: bigint;
  createdAt?: number;
}

/** What a bid id resolves to: still open, or converted into a swap. */
export type BidLookup = { bid: BidPublic; filledHEvm?: never } | { bid?: never; filledHEvm: string };

function decodeBid(rec: BidRecord): BidPublic {
  return {
    id: String(rec.id ?? ""),
    creatorPkh: String(rec.creatorPkh ?? "") as Digest,
    creatorEth: String(rec.creatorEth ?? "") as Address,
    token: rec.token === "WNOCK" ? "WNOCK" : "USDC",
    quoteAmount: String(rec.quoteAmount ?? ""),
    nockGift: BigInt(String(rec.nockGift ?? "0")),
    createdAt: rec.createdAt != null ? Number(rec.createdAt) : undefined,
  };
}

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

  /** Either participant cancels a swap while nothing is on-chain. */
  cancel(hEvm: string): Promise<void> {
    return this.api.cancel(hEvm);
  }

  /** Post a buy order: pay `quoteAmount` of `token` on Base for native NOCK. */
  async createBid(bid: {
    token: TokenKey;
    quoteAmount: string;
    nockGift: bigint;
    creatorEth: string;
  }): Promise<BidPublic> {
    const rec = await this.api.createBid({
      token: bid.token,
      quoteAmount: bid.quoteAmount,
      nockGift: bid.nockGift.toString(),
      creatorEth: bid.creatorEth,
    });
    return decodeBid(rec);
  }

  /** Marketplace: open buy orders anyone can browse (no auth needed). */
  async listBids(): Promise<BidPublic[]> {
    const recs = await this.api.listBids();
    return recs.map(decodeBid).filter((b) => b.id);
  }

  /** Read one buy order (open read): the open bid, where it went after a fill
   *  (`{ filledHEvm }` → the swap), or null once cancelled/expired. */
  async getBid(id: string): Promise<BidLookup | null> {
    const rec = await this.api.getBid(id);
    if (!rec) return null;
    if (rec.filledHEvm) return { filledHEvm: String(rec.filledHEvm) };
    const bid = decodeBid(rec);
    return bid.id ? { bid } : null;
  }

  /** Fill a buy order with a freshly generated swap; returns the created swap. */
  async fillBid(id: string, swap: SwapPublic): Promise<SwapPublic> {
    const rec = await this.api.fillBid(id, encoded(swap));
    return decodeSwapParams(JSON.stringify(rec));
  }

  /** Creator cancels their own open buy order. */
  cancelBid(id: string): Promise<void> {
    return this.api.cancelBid(id);
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
