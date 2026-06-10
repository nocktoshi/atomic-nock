import { describe, it, expect, vi } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../swap.js";
import {
  claimNockAction,
  resolvePreimage,
  lockUsdcAction,
  refundUsdcAction,
  type ClaimDeps,
  type PreimageDeps,
  type LockUsdcDeps,
  type RefundUsdcDeps,
} from "./buyer.js";

const PREIMAGE = new Uint8Array([1, 2, 3, 4]);

function makeSwap(overrides: Partial<SwapPublic> = {}): SwapPublic {
  return {
    hNock: "HNOCK" as Digest,
    hEvm: "0xevm" as Hex,
    sellerPkh: "SELLER" as Digest,
    buyerPkh: "BUYER" as Digest,
    sellerEth: "0xseller" as Address,
    buyerEth: "0xbuyer" as Address,
    usdcAmount: "1.0",
    nockRefundHeight: 123n,
    usdcTimelock: 999n,
    nockGift: 65536n,
    lockFirstName: "LOCKFN" as Digest,
    parentHash: "PARENT" as Digest,
    birthOutputIndex: 0,
    ...overrides,
  };
}

function claimDeps(): ClaimDeps {
  return {
    claimNock: vi.fn(async () => "tx-claim-123"),
    assertPreimageMatchesHNock: vi.fn(async () => {}),
  };
}

describe("claimNockAction", () => {
  it("requires a resolved preimage", async () => {
    await expect(
      claimNockAction(
        { swap: makeSwap(), preimageJam: null, lockFirstName: "", gift: "" },
        claimDeps()
      )
    ).rejects.toThrow("No preimage");
  });

  it("requires a lockFirstName", async () => {
    await expect(
      claimNockAction(
        { swap: makeSwap({ lockFirstName: undefined }), preimageJam: PREIMAGE, lockFirstName: "  ", gift: "" },
        claimDeps()
      )
    ).rejects.toThrow("lockFirstName missing");
  });

  it("verifies the preimage against hNock before claiming", async () => {
    const deps = claimDeps();
    (deps.assertPreimageMatchesHNock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Preimage does not match swap hNock")
    );
    await expect(
      claimNockAction({ swap: makeSwap(), preimageJam: PREIMAGE, lockFirstName: "", gift: "" }, deps)
    ).rejects.toThrow("Preimage does not match swap hNock");
    expect(deps.claimNock).not.toHaveBeenCalled();
  });

  it("calls claimNock with the exact params, returns txId, records it on the swap", async () => {
    const deps = claimDeps();
    const swap = makeSwap();
    const { txId } = await claimNockAction(
      { swap, preimageJam: PREIMAGE, lockFirstName: "", gift: "" },
      deps
    );

    expect(txId).toBe("tx-claim-123");
    expect(swap.nockClaimTxId).toBe("tx-claim-123");
    expect(deps.claimNock).toHaveBeenCalledWith({
      lockFirstName: "LOCKFN",
      preimageJam: PREIMAGE,
      hNock: "HNOCK",
      sellerPkh: "SELLER",
      buyerPkh: "BUYER",
      refundHeight: 123n,
      gift: "65536",
      parentHash: "PARENT",
      birthOutputIndex: 0,
    });
  });
});

function preimageDeps(): PreimageDeps {
  return {
    getPreimageFromWithdrawTx: vi.fn(async () => new Uint8Array([9, 9])),
    findPreimageFromSwapWithdraw: vi.fn(async () => ({ txHash: "0xscanned", preimageJam: new Uint8Array([7, 7]) })),
    assertPreimageMatchesHNock: vi.fn(async () => {}),
  };
}

describe("resolvePreimage", () => {
  it("returns cached without touching deps", async () => {
    const deps = preimageDeps();
    const res = await resolvePreimage({ swap: makeSwap(), cached: PREIMAGE, withdrawTx: "", swapId: null }, deps);
    expect(res.preimageJam).toBe(PREIMAGE);
    expect(deps.getPreimageFromWithdrawTx).not.toHaveBeenCalled();
  });

  it("loads from a withdraw tx and verifies it", async () => {
    const deps = preimageDeps();
    const res = await resolvePreimage({ swap: makeSwap(), cached: null, withdrawTx: "0xtx" as Hex, swapId: null }, deps);
    expect(deps.getPreimageFromWithdrawTx).toHaveBeenCalledWith("0xtx");
    expect(res.preimageJam).toEqual(new Uint8Array([9, 9]));
  });

  it("falls back to scanning by swapId", async () => {
    const deps = preimageDeps();
    const res = await resolvePreimage({ swap: makeSwap(), cached: null, withdrawTx: "", swapId: "0xswap" as Hex }, deps);
    expect(deps.findPreimageFromSwapWithdraw).toHaveBeenCalledWith("0xswap");
    expect(res.txHash).toBe("0xscanned");
  });

  it("auto-loads from the swap's recorded usdcWithdrawTxHash (no manual tx, no swapId)", async () => {
    const deps = preimageDeps();
    const swap = makeSwap({ usdcWithdrawTxHash: "0xrecorded" });
    const res = await resolvePreimage({ swap, cached: null, withdrawTx: "", swapId: null }, deps);
    expect(deps.getPreimageFromWithdrawTx).toHaveBeenCalledWith("0xrecorded");
    expect(res.txHash).toBe("0xrecorded");
    expect(res.preimageJam).toEqual(new Uint8Array([9, 9]));
  });

  it("prefers an explicit manual tx over the recorded one", async () => {
    const deps = preimageDeps();
    const swap = makeSwap({ usdcWithdrawTxHash: "0xrecorded" });
    await resolvePreimage({ swap, cached: null, withdrawTx: "0xmanual" as Hex, swapId: null }, deps);
    expect(deps.getPreimageFromWithdrawTx).toHaveBeenCalledWith("0xmanual");
  });

  it("throws when no source is available", async () => {
    await expect(
      resolvePreimage({ swap: makeSwap(), cached: null, withdrawTx: "", swapId: null }, preimageDeps())
    ).rejects.toThrow("Preimage not loaded");
  });
});

describe("lockUsdcAction", () => {
  it("forwards the swap's seller/amount to approveAndLock and records lock state", async () => {
    const approveAndLock = vi.fn(async () => ({
      swapId: "0xswapid" as Hex,
      lockHash: "0xlocktx" as Hex,
      buyer: "0xBUYERADDR" as Address,
    }));
    const deps: LockUsdcDeps = { approveAndLock, htlcAddressSet: () => true };
    const swap = makeSwap({ buyerEth: undefined });

    const res = await lockUsdcAction({ swap }, deps);

    expect(res.swapId).toBe("0xswapid");
    expect(res.lockTxHash).toBe("0xlocktx");
    expect(swap.buyerEth).toBe("0xBUYERADDR");
    expect(swap.usdcLockTxHash).toBe("0xlocktx");
    expect(approveAndLock).toHaveBeenCalledWith({
      seller: "0xseller",
      amountUsdc: "1.0",
      hashlock: "0xevm",
      timelock: 999n,
    });
  });

  it("fails fast when HTLC address is not configured", async () => {
    const deps: LockUsdcDeps = { approveAndLock: vi.fn(), htlcAddressSet: () => false };
    await expect(lockUsdcAction({ swap: makeSwap() }, deps)).rejects.toThrow("VITE_HTLC_ADDRESS");
    expect(deps.approveAndLock).not.toHaveBeenCalled();
  });
});

describe("refundUsdcAction", () => {
  it("computes the swapId and calls refund, recording the tx", async () => {
    const deps: RefundUsdcDeps = {
      usdcToAtomic: vi.fn(async () => 1_000_000n),
      computeSwapId: vi.fn(async () => "0xid" as Hex),
      refundUsdc: vi.fn(async () => "0xrefundtx" as Hex),
    };
    const swap = makeSwap();
    const { hash } = await refundUsdcAction({ swap }, deps);
    expect(deps.computeSwapId).toHaveBeenCalledWith({
      seller: "0xseller",
      buyer: "0xbuyer",
      amount: 1_000_000n,
      hashlock: "0xevm",
      timelock: 999n,
    });
    expect(deps.refundUsdc).toHaveBeenCalledWith("0xid");
    expect(hash).toBe("0xrefundtx");
    expect(swap.usdcRefundTxHash).toBe("0xrefundtx");
  });

  it("requires an on-chain lock (buyerEth set)", async () => {
    const deps: RefundUsdcDeps = {
      usdcToAtomic: vi.fn(),
      computeSwapId: vi.fn(),
      refundUsdc: vi.fn(),
    };
    await expect(refundUsdcAction({ swap: makeSwap({ buyerEth: undefined }) }, deps)).rejects.toThrow(
      "no on-chain lock"
    );
  });
});
