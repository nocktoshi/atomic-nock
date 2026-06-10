import { describe, it, expect, vi } from "vitest";
import type { Hex, Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic } from "../swap.js";
import {
  generateSwapAction,
  lockNockAction,
  withdrawUsdcAction,
  type GenerateSwapDeps,
  type LockNockDeps,
  type WithdrawUsdcDeps,
} from "./seller.js";

function genDeps(overrides: Partial<GenerateSwapDeps> = {}): GenerateSwapDeps {
  return {
    generateSwapSecret: vi.fn(async () => ({ preimageJam: new Uint8Array([1, 2]), secretHex: "0102" })),
    computeHashes: vi.fn(async () => ({ hNock: "HNOCK_FROM_DEP" as Digest, hEvm: "0xEVM" as Hex })),
    isPlausibleWalletAddress: vi.fn(() => true),
    assertBase58Digest: vi.fn(() => {}),
    refundDelta: 10_000n,
    usdcTimeoutSec: 86_400,
    ...overrides,
  };
}

const validInput = {
  buyerPkh: "BUYER_ADDR",
  walletAddress: "SELLER_ADDR",
  sellerEth: "0x1111111111111111111111111111111111111111",
  usdcAmount: "2.5",
  gift: "65536",
  refundHeight: "85000",
};

describe("generateSwapAction", () => {
  it("builds a SwapPublic and captures sellerEth + usdcAmount + preimage", async () => {
    const deps = genDeps();
    const { swap, preimageJam } = await generateSwapAction(validInput, deps);
    expect(swap.hNock).toBe("HNOCK_FROM_DEP");
    expect(swap.hEvm).toBe("0xEVM");
    expect(swap.sellerEth).toBe(validInput.sellerEth);
    expect(swap.usdcAmount).toBe("2.5");
    expect(swap.nockGift).toBe(65536n);
    expect(preimageJam).toEqual(new Uint8Array([1, 2]));
  });

  it("uses the provided refund height", async () => {
    const { refundHeight } = await generateSwapAction(validInput, genDeps());
    expect(refundHeight).toBe(85_000n);
  });

  it("requires a refund block height (no magic-constant fallback)", async () => {
    await expect(
      generateSwapAction({ ...validInput, refundHeight: "" }, genDeps())
    ).rejects.toThrow("Refund block height is required");
  });

  it("rejects a non-plausible wallet address", async () => {
    const deps = genDeps({ isPlausibleWalletAddress: vi.fn(() => false) });
    await expect(generateSwapAction(validInput, deps)).rejects.toThrow("nockblocks wallet address");
  });

  it("requires a connected ETH address", async () => {
    await expect(
      generateSwapAction({ ...validInput, sellerEth: "" }, genDeps())
    ).rejects.toThrow("Connect MetaMask");
  });

});

function preLockSwap(): SwapPublic {
  return {
    hNock: "HNOCK" as Digest,
    hEvm: "0xevm" as Hex,
    sellerPkh: "OLD_SELLER" as Digest,
    buyerPkh: "BUYER" as Digest,
    sellerEth: "0x1111111111111111111111111111111111111111" as Address,
    usdcAmount: "1.0",
    nockRefundHeight: 63000n,
    usdcTimelock: 999n,
    nockGift: 65536n,
  };
}

function lockDeps(overrides: Partial<LockNockDeps> = {}): LockNockDeps {
  return {
    isPlausibleWalletAddress: vi.fn(() => true),
    lockNock: vi.fn(async () => ({
      txId: "tx-lock-1",
      lockFirstName: "LOCK_FIRST_NAME" as Digest,
      parentHash: "PARENT_HASH" as Digest,
      birthOutputIndex: 0,
      preview: {
        giftOutputFirstName: "GIFT_FN" as Digest,
        lockRoot: "LOCK_ROOT" as Digest,
        swapLockFirstNameWasLockRoot: false,
      },
    })) as unknown as LockNockDeps["lockNock"],
    ...overrides,
  };
}

describe("lockNockAction", () => {
  it("records lockFirstName/parentHash/txId on the swap", async () => {
    const { swap } = await lockNockAction(
      { swap: preLockSwap(), walletAddress: "NEW_SELLER_ADDR" },
      lockDeps()
    );
    expect(swap.lockFirstName).toBe("LOCK_FIRST_NAME");
    expect(swap.parentHash).toBe("PARENT_HASH");
    expect(swap.birthOutputIndex).toBe(0);
    expect(swap.sellerPkh).toBe("NEW_SELLER_ADDR");
    expect(swap.nockLockTxId).toBe("tx-lock-1");
  });

  it("requires a generated swap", async () => {
    await expect(lockNockAction({ swap: null, walletAddress: "X" }, lockDeps())).rejects.toThrow(
      "Generate swap first"
    );
  });
});

describe("withdrawUsdcAction", () => {
  it("computes swapId from swap fields, fetches preimage, withdraws", async () => {
    const deps: WithdrawUsdcDeps = {
      usdcToAtomic: vi.fn(async () => 1_000_000n),
      computeSwapId: vi.fn(async () => "0xid" as Hex),
      getSellerPreimage: vi.fn(async () => new Uint8Array([5, 5])),
      withdrawUsdc: vi.fn(async () => "0xwithdrawtx" as Hex),
    };
    const swap = { ...preLockSwap(), buyerEth: "0x2222222222222222222222222222222222222222" as Address };
    const { hash } = await withdrawUsdcAction({ swap }, deps);
    expect(deps.computeSwapId).toHaveBeenCalledWith({
      seller: swap.sellerEth,
      buyer: swap.buyerEth,
      amount: 1_000_000n,
      hashlock: swap.hEvm,
      timelock: swap.usdcTimelock,
    });
    expect(deps.withdrawUsdc).toHaveBeenCalledWith({ swapId: "0xid", preimageJam: new Uint8Array([5, 5]) });
    expect(hash).toBe("0xwithdrawtx");
    expect(swap.usdcWithdrawTxHash).toBe("0xwithdrawtx");
  });

  it("errors when the buyer has not locked yet", async () => {
    const deps = {} as WithdrawUsdcDeps;
    await expect(withdrawUsdcAction({ swap: preLockSwap() }, deps)).rejects.toThrow(
      "Buyer must lock USDC"
    );
  });
});
