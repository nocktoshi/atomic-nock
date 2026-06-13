/**
 * Parity golden vectors for protocol-critical rose-ts outputs.
 */
import { describe, it, expect } from "vitest";
import { keccak256 } from "viem";
import { hashPreimage, hashPublicKey } from "@nockchain/rose-ts";
import { htlcLockRootDigest } from "./nock/tx.js";
import { encodeSwapParams } from "./swap.js";
import { toAtomic } from "./evm/htlc.js";

const GOLDEN_JAM = [
  1, 4, 94, 58, 17, 242, 138, 59, 221, 17, 3, 236, 145, 212, 172, 51, 41, 91, 17, 50, 64, 143, 128,
  4, 27, 38, 225, 48, 160, 7, 16, 192, 24, 8, 250, 63, 48, 130, 139, 12, 240, 187, 33, 147, 240,
  145, 120, 104, 131, 3, 244, 36, 50, 199, 221, 55, 56, 152, 120, 0, 129, 72, 209, 194, 114, 52,
  110, 8, 86, 192, 239, 178, 176, 65, 126, 22, 54, 38, 6,
];

describe("parity export", () => {
  it("matches golden vectors from rose-ts", () => {
    const jam = Uint8Array.from(GOLDEN_JAM);
    const hNock = hashPreimage(jam) as unknown as string;
    const buyerPkh = hashPublicKey(new Uint8Array(97).fill(0)) as unknown as string;
    const sellerPkh = hashPublicKey(new Uint8Array(97).fill(1)) as unknown as string;
    const refundHeight = 1000;

    const lockRoot = htlcLockRootDigest(
      hNock as never,
      buyerPkh as never,
      sellerPkh as never,
      BigInt(refundHeight)
    ) as unknown as string;

    const swap = {
      hNock: hNock as never,
      hEvm: "0xEvM" as never,
      sellerPkh: sellerPkh as never,
      buyerPkh: buyerPkh as never,
      nockRefundHeight: 1000n,
      usdcTimelock: 5000n,
      nockGift: 65536n,
      sellerEth: "0xSeller" as never,
      buyerEth: "0xBuyer" as never,
      usdcAmount: "1.5",
      birthOutputIndex: 2,
      nockLockTxId: "0xnl",
    };

    expect({
      hashPreimage: { jam: GOLDEN_JAM, digest: hNock },
      hashPublicKey: { zero97: buyerPkh, one97: sellerPkh },
      htlcLockRoot: { hNock, buyerPkh, sellerPkh, refundHeight, lockRoot },
      keccak256: { jam: GOLDEN_JAM, hex: keccak256(jam) },
      toAtomic: [
        { amount: "1.0", decimals: 6, result: toAtomic("1.0", 6).toString() },
        { amount: "2.5", decimals: 6, result: toAtomic("2.5", 6).toString() },
        { amount: "1.23456789", decimals: 6, result: toAtomic("1.23456789", 6).toString() },
        { amount: "1.0", decimals: 18, result: toAtomic("1.0", 18).toString() },
      ],
      encodeSwapParams: { json: encodeSwapParams(swap as never) },
    }).toMatchSnapshot();
  });
});