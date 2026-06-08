import { describe, it, expect, vi } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../swap.js";
import { createPriceProvider, impliedNockUsd } from "./price.js";

function res(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("createPriceProvider", () => {
  it("returns null when no url is configured", async () => {
    const p = createPriceProvider("", vi.fn());
    expect(await p.getNockUsd()).toBeNull();
  });

  it("extracts a CoinGecko-shaped price and caches it", async () => {
    const fetcher = vi.fn(async () => res({ nock: { usd: 1.23 } }));
    const p = createPriceProvider("https://x", fetcher as unknown as typeof fetch, 60_000);
    expect(await p.getNockUsd()).toBe(1.23);
    expect(await p.getNockUsd()).toBe(1.23); // cached
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("handles {usd} and {price} shapes", async () => {
    expect(await createPriceProvider("u", (async () => res({ usd: 2 })) as unknown as typeof fetch).getNockUsd()).toBe(2);
    expect(await createPriceProvider("u", (async () => res({ price: 3 })) as unknown as typeof fetch).getNockUsd()).toBe(3);
  });

  it("degrades to null on a failed fetch", async () => {
    const p = createPriceProvider("u", (async () => res({}, false)) as unknown as typeof fetch);
    expect(await p.getNockUsd()).toBeNull();
  });
});

describe("impliedNockUsd", () => {
  const base: SwapPublic = {
    hNock: "H" as Digest,
    hEvm: "0x" as Hex,
    sellerPkh: "S" as Digest,
    buyerPkh: "B" as Digest,
    sellerEth: "0xs" as Address,
    nockRefundHeight: 1n,
    usdcTimelock: 1n,
    nockGift: 65536n, // 1 NOCK
  };
  it("computes USDC per NOCK", () => {
    expect(impliedNockUsd({ ...base, usdcAmount: "2.5" })).toBe(2.5);
  });
  it("returns null without an amount", () => {
    expect(impliedNockUsd(base)).toBeNull();
  });
});
