import { describe, it, expect } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../../swap.js";
import { MemoryKvStore } from "../storage/memory-kv.js";
import { SwapRepository } from "./swap-repo.js";
import { MemorySwapApi } from "./swap-api.js";

/** A repo backed by a single in-memory KV (reads) + matching SwapApi (writes). */
function makeRepo() {
  const kv = new MemoryKvStore();
  return new SwapRepository(kv, new MemorySwapApi(kv));
}

function makeSwap(over: Partial<SwapPublic> = {}): SwapPublic {
  return {
    hNock: "HNOCK" as Digest,
    hEvm: "0xAbC123" as Hex,
    sellerPkh: "SELLER_PKH" as Digest,
    buyerPkh: "BUYER_PKH" as Digest,
    sellerEth: "0xSeLLeReth" as Address,
    buyerEth: "0xBuYeReth" as Address,
    usdcAmount: "1.0",
    nockRefundHeight: 100n,
    usdcTimelock: 200n,
    nockGift: 65536n,
    ...over,
  };
}

describe("SwapRepository", () => {
  it("stores and fetches a swap by hEvm (case-insensitive)", async () => {
    const repo = makeRepo();
    const swap = makeSwap();
    await repo.create(swap);
    const got = await repo.get("0xabc123");
    expect(got?.sellerPkh).toBe("SELLER_PKH");
    expect(got?.usdcAmount).toBe("1.0");
  });

  it("indexes by every participant address", async () => {
    const repo = makeRepo();
    const swap = makeSwap();
    await repo.create(swap);

    expect((await repo.listForAddress("0xSELLERETH")).map((s) => s.hEvm)).toEqual(["0xAbC123"]);
    expect((await repo.listForAddress("0xbuyereth")).length).toBe(1);
    expect((await repo.listForNockPkh("SELLER_PKH")).length).toBe(1);
    expect((await repo.listForNockPkh("BUYER_PKH")).length).toBe(1);
    expect((await repo.listForAddress("0xnobody")).length).toBe(0);
  });

  it("keeps multiple swaps separate (no collision)", async () => {
    const repo = makeRepo();
    await repo.create(makeSwap({ hEvm: "0xaaa" as Hex }));
    await repo.create(makeSwap({ hEvm: "0xbbb" as Hex }));
    const list = await repo.listForNockPkh("SELLER_PKH");
    expect(list.map((s) => s.hEvm).sort()).toEqual(["0xaaa", "0xbbb"]);
  });
});
