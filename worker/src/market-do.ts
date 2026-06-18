/**
 * Market Durable Object — extends the Cloudflare base class and exposes
 * MarketCore logic as RPC methods (see the counter example in CF docs).
 */
import { DurableObject } from "cloudflare:workers";
import type { SwapRecord } from "./contract.js";
import type { PnlEntry, TrackedSwap, TrackedSwapPatch } from "../../src/solver-state.js";
import type { RfqSide, SolverRfqResponse } from "../../src/market/solver-rfq.js";
import {
  MarketCore,
  type BidRecord,
  type ImportPayload,
  type RfqQuote,
} from "./market.js";
import { doMarketStorage } from "./market-do-storage.js";
import { throwRpcError } from "./rpc-errors.js";
import type { Env } from "./swaps.js";

export class Market extends DurableObject<Env> {
  private readonly core: MarketCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new MarketCore(doMarketStorage(ctx.storage));
  }

  /** Hold a sized RFQ until the solver answers over the queue (online-check +
   *  rfq.created enqueue happen in awaitRfq; the rendezvous is in MarketCore). */
  async awaitRfqResponse(
    rfqId: string,
    side: RfqSide,
    amountIn: string,
    holdMs: number
  ): Promise<SolverRfqResponse> {
    try {
      return await this.core.awaitRfqResponse(rfqId, side, amountIn, holdMs);
    } catch (e) {
      throwRpcError(e);
    }
  }

  /** Wake a held RFQ with the solver's quote (no-op if it already timed out). */
  resolveRfqResponse(rfqId: string, quote: RfqQuote): void {
    this.core.resolveRfqResponse(rfqId, quote);
  }

  async loadSwap(hEvm: string): Promise<SwapRecord | null> {
    try {
      return await this.core.loadSwap(hEvm);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async createSwap(swap: Record<string, unknown>, sessionPkh: string): Promise<SwapRecord> {
    try {
      return await this.core.createSwap(swap, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async claimSwap(hEvm: string, buyerEth: string, sessionPkh: string): Promise<SwapRecord> {
    try {
      return await this.core.claimSwap(hEvm, buyerEth, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async cancelSwap(hEvm: string, sessionPkh: string): Promise<void> {
    try {
      await this.core.cancelSwap(hEvm, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async advanceSwap(
    hEvm: string,
    fields: Record<string, unknown>,
    sessionPkh: string,
    expectedVersion?: number
  ): Promise<SwapRecord> {
    try {
      return await this.core.advanceSwap(hEvm, fields, sessionPkh, expectedVersion);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async listMine(pkh: string): Promise<string[]> {
    try {
      return await this.core.listMine(pkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async lookupBid(bidId: string): Promise<BidRecord | { filledHEvm: string } | null> {
    try {
      return await this.core.lookupBid(bidId);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async createBid(bid: Record<string, unknown>, sessionPkh: string): Promise<BidRecord> {
    try {
      return await this.core.createBid(bid, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async cancelBid(bidId: string, sessionPkh: string): Promise<void> {
    try {
      await this.core.cancelBid(bidId, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async fillBid(
    bidId: string,
    swap: Record<string, unknown>,
    sessionPkh: string
  ): Promise<{ swap: SwapRecord; bid: BidRecord }> {
    try {
      return await this.core.fillBid(bidId, swap, sessionPkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async feed(limit = 50): Promise<{ swaps: SwapRecord[]; bids: BidRecord[]; ts: number }> {
    try {
      return await this.core.feed(limit);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async listTrackedSwaps(pkh: string): Promise<TrackedSwap[]> {
    try {
      return await this.core.listTrackedSwaps(pkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async loadTrackedSwap(pkh: string, hEvm: string): Promise<TrackedSwap | null> {
    try {
      return await this.core.loadTrackedSwap(pkh, hEvm);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async upsertTrackedSwap(pkh: string, swap: TrackedSwap): Promise<TrackedSwap> {
    try {
      return await this.core.upsertTrackedSwap(pkh, swap);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async patchTrackedSwap(pkh: string, hEvm: string, patch: TrackedSwapPatch): Promise<TrackedSwap> {
    try {
      return await this.core.patchTrackedSwap(pkh, hEvm, patch);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async putSwapSecret(pkh: string, hEvm: string, secretHex: string): Promise<TrackedSwap> {
    try {
      return await this.core.putSwapSecret(pkh, hEvm, secretHex);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async listPnl(pkh: string): Promise<PnlEntry[]> {
    try {
      return await this.core.listPnl(pkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async appendPnl(pkh: string, entry: PnlEntry): Promise<void> {
    try {
      await this.core.appendPnl(pkh, entry);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async touchHeartbeat(pkh: string): Promise<void> {
    try {
      await this.core.touchHeartbeat(pkh);
    } catch (e) {
      throwRpcError(e);
    }
  }

  async online(): Promise<boolean> {
    try {
      return await this.core.online();
    } catch (e) {
      throwRpcError(e);
    }
  }

  async importData(payload: ImportPayload): Promise<Record<string, number>> {
    try {
      return await this.core.importData(payload);
    } catch (e) {
      throwRpcError(e);
    }
  }
}