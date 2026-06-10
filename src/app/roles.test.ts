import { describe, it, expect } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../swap.js";
import {
  roleForSwap,
  swapStatus,
  refundAvailability,
  verifySwapWallets,
} from "./roles.js";

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

const sellerConn = {
  eth: "0xSeller" as Address,
  nock: { pkh: "SELLER_PKH", address: "SELLER_ADDR" },
};
const buyerConn = {
  eth: "0xBuyer" as Address,
  nock: { pkh: "BUYER_PKH" },
};

describe("roleForSwap", () => {
  it("detects seller/buyer when both chains match", () => {
    expect(roleForSwap(makeSwap(), sellerConn)).toBe("seller");
    expect(roleForSwap(makeSwap(), buyerConn)).toBe("buyer");
  });

  it("detects seller by nockblocks address", () => {
    expect(
      roleForSwap(makeSwap({ sellerPkh: "SELLER_ADDR" as Digest }), {
        eth: "0xSeller",
        nock: { pkh: "IRIS_PKH", address: "SELLER_ADDR" },
      })
    ).toBe("seller");
  });

  it("detects by single chain for dashboard hints", () => {
    expect(roleForSwap(makeSwap(), { eth: "0xSELLER" })).toBe("seller");
    expect(roleForSwap(makeSwap(), { nock: { pkh: "BUYER_PKH" } })).toBe("buyer");
  });

  it("returns null when no match", () => {
    expect(
      roleForSwap(makeSwap(), { eth: "0xother", nock: { pkh: "OTHER" } })
    ).toBeNull();
  });
});

describe("verifySwapWallets", () => {
  it("accepts matching seller wallets", () => {
    const v = verifySwapWallets(makeSwap(), sellerConn);
    expect(v.ok).toBe(true);
    expect(v.role).toBe("seller");
  });

  it("accepts matching buyer wallets", () => {
    const v = verifySwapWallets(makeSwap(), buyerConn);
    expect(v.ok).toBe(true);
    expect(v.role).toBe("buyer");
  });

  it("allows buyer Base before USDC lock when Iris matches buyer", () => {
    const v = verifySwapWallets(makeSwap({ buyerEth: undefined }), {
      eth: "0xFreshBuyer" as Address,
      nock: { pkh: "BUYER_PKH" },
    });
    expect(v.ok).toBe(true);
    expect(v.role).toBe("buyer");
  });

  it("rejects mismatched Iris wallet", () => {
    const v = verifySwapWallets(makeSwap(), {
      eth: "0xBuyer",
      nock: { pkh: "WRONG" },
    });
    expect(v.ok).toBe(false);
    expect(v.nockOk).toBe(false);
  });

  it("rejects cross-party wallets on the two chains", () => {
    const v = verifySwapWallets(makeSwap(), {
      eth: "0xSeller",
      nock: { pkh: "BUYER_PKH" },
    });
    expect(v.ok).toBe(false);
    expect(v.role).toBeNull();
  });

  it("skips participant checks for draft swaps", () => {
    const v = verifySwapWallets(makeSwap({ hEvm: undefined as unknown as Hex }), {
      eth: "0xanything",
      nock: { pkh: "ANY" },
    });
    expect(v.ok).toBe(true);
    expect(v.role).toBeNull();
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
