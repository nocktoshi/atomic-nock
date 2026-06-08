import { describe, it, expect } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../swap.js";
import { roleForSwap, swapStatus, refundAvailability } from "./roles.js";

function makeSwap(over: Partial<SwapPublic> = {}): SwapPublic {
  return {
    hNock: "HNOCK" as Digest,
    hEvm: "0xevm" as Hex,
    sellerPkh: "SELLER_PKH" as Digest,
    buyerPkh: "BUYER_PKH" as Digest,
    sellerEth: "0xSeller" as Address,
    buyerEth: "0xBuyer" as Address,
    usdcAmount: "1.0",
    nockRefundHeight: 1000n,
    usdcTimelock: 5000n,
    nockGift: 65536n,
    ...over,
  };
}

describe("roleForSwap", () => {
  it("detects seller/buyer by eth (case-insensitive)", () => {
    expect(roleForSwap(makeSwap(), { eth: "0xSELLER" })).toBe("seller");
    expect(roleForSwap(makeSwap(), { eth: "0xbuyer" })).toBe("buyer");
  });
  it("detects by nock pkh", () => {
    expect(roleForSwap(makeSwap(), { pkh: "SELLER_PKH" })).toBe("seller");
    expect(roleForSwap(makeSwap(), { pkh: "BUYER_PKH" })).toBe("buyer");
  });
  it("returns null when no match", () => {
    expect(roleForSwap(makeSwap(), { eth: "0xother", pkh: "OTHER" })).toBeNull();
  });
});

describe("swapStatus", () => {
  it("derives the most-advanced stage", () => {
    expect(swapStatus(makeSwap())).toBe("created");
    expect(swapStatus(makeSwap({ lockFirstName: "x" as Digest }))).toBe("nock-locked");
    expect(swapStatus(makeSwap({ usdcLockTxHash: "0x1" }))).toBe("usdc-locked");
    expect(swapStatus(makeSwap({ usdcWithdrawTxHash: "0x2" }))).toBe("withdrawn");
    expect(swapStatus(makeSwap({ nockClaimTxId: "t" }))).toBe("claimed");
    expect(swapStatus(makeSwap({ usdcRefundTxHash: "0x3" }))).toBe("refunded");
  });
});

describe("refundAvailability", () => {
  const locked = makeSwap({ usdcLockTxHash: "0x1", lockFirstName: "LF" as Digest });

  it("eth refund only after the timelock", () => {
    expect(refundAvailability(locked, { nowSec: 4999 }).eth).toBe(false);
    expect(refundAvailability(locked, { nowSec: 5000 }).eth).toBe(true);
  });

  it("eth refund blocked once withdrawn/refunded", () => {
    expect(refundAvailability(makeSwap({ usdcLockTxHash: "0x1", usdcWithdrawTxHash: "0x9" }), { nowSec: 9999 }).eth).toBe(false);
  });

  it("eth refund respects on-chain state", () => {
    const r = refundAvailability(locked, {
      nowSec: 9999,
      onchainLock: { amount: 0n, withdrawn: false, refunded: false },
    });
    expect(r.eth).toBe(false);
  });

  it("nock refund only at/after the refund height", () => {
    expect(refundAvailability(locked, { nowSec: 0, nockHeight: 999 }).nock).toBe(false);
    expect(refundAvailability(locked, { nowSec: 0, nockHeight: 1000 }).nock).toBe(true);
  });

  it("nock refund blocked once claimed", () => {
    const claimed = makeSwap({ lockFirstName: "LF" as Digest, nockClaimTxId: "t" });
    expect(refundAvailability(claimed, { nowSec: 0, nockHeight: 99999 }).nock).toBe(false);
  });
});
