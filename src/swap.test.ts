import { describe, it, expect } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import { encodeSwapParams, decodeSwapParams, type SwapPublic } from "./swap.js";

function makeSwap(over: Partial<SwapPublic> = {}): SwapPublic {
  return {
    hNock: "HNOCK" as Digest,
    hEvm: "0xAbC123" as Hex,
    sellerPkh: "SELLER_PKH" as Digest,
    buyerPkh: "BUYER_PKH" as Digest,
    sellerEth: "0xSeLLeReth" as Address,
    usdcAmount: "1.0",
    nockRefundHeight: 100n,
    usdcTimelock: 200n,
    nockGift: 65536n,
    ...over,
  };
}

describe("swap encode/decode — multi-asset", () => {
  it("round-trips a swap with token and createdAt", () => {
    const swap = makeSwap({ token: "WNOCK", createdAt: 1_770_000_000 });
    const got = decodeSwapParams(encodeSwapParams(swap));
    expect(got.token).toBe("WNOCK");
    expect(got.createdAt).toBe(1_770_000_000);
    expect(got.nockGift).toBe(65536n);
  });

  it("round-trips a swap without token (legacy)", () => {
    const got = decodeSwapParams(encodeSwapParams(makeSwap()));
    expect(got.token).toBeUndefined();
    expect(got.createdAt).toBeUndefined();
  });

  it("omits absent token/createdAt from the wire JSON (back-compat)", () => {
    const raw = JSON.parse(encodeSwapParams(makeSwap())) as Record<string, unknown>;
    expect("token" in raw).toBe(false);
    expect("createdAt" in raw).toBe(false);
  });

  it("decodes legacy JSON lacking the new fields", () => {
    const legacy = JSON.stringify({
      hNock: "HN",
      hEvm: "0xdef",
      sellerPkh: "S",
      buyerPkh: "B",
      nockGift: "1",
      nockRefundHeight: "2",
      usdcTimelock: "3",
    });
    const got = decodeSwapParams(legacy);
    expect(got.token).toBeUndefined();
    expect(got.usdcTimelock).toBe(3n);
  });

  it("normalizes an unknown token value to undefined (= USDC)", () => {
    const json = encodeSwapParams(makeSwap()).replace(
      '"hNock"',
      '"token":"DOGE","hNock"'
    );
    expect(decodeSwapParams(json).token).toBeUndefined();
  });
});
