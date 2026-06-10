import { describe, it, expect } from "vitest";
import { swapEvents } from "./notify.js";
import type { SwapRecord } from "./contract.js";

const base: SwapRecord = {
  hEvm: "0xabc",
  sellerPkh: "SELLER",
  buyerPkh: "BUYER",
  sellerEth: "0xseller",
  usdcAmount: "1.5",
  version: 2,
};

const step = (prev: Partial<SwapRecord> | null, next: Partial<SwapRecord>) =>
  swapEvents(
    prev ? ({ ...base, ...prev } as SwapRecord) : null,
    { ...base, ...next } as SwapRecord
  );

describe("swapEvents — every state transition notifies the counterparty", () => {
  it("claim → seller", () => {
    const ev = step({ buyerPkh: "" }, { buyerPkh: "BUYER" });
    expect(ev).toHaveLength(1);
    expect(ev[0].recipientPkh).toBe("SELLER");
    expect(ev[0].title).toMatch(/claimed/i);
  });

  it("creation with a preset buyer is NOT a claim event", () => {
    expect(step(null, { buyerPkh: "BUYER" })).toHaveLength(0);
  });

  it("NOCK locked → buyer", () => {
    const ev = step({}, { lockFirstName: "LFN" });
    expect(ev).toHaveLength(1);
    expect(ev[0].recipientPkh).toBe("BUYER");
    expect(ev[0].body).toMatch(/USDC/);
  });

  it("NOCK locked on a wNOCK swap says wNOCK", () => {
    const ev = step({ token: "WNOCK" }, { token: "WNOCK", lockFirstName: "LFN" });
    expect(ev[0].body).toMatch(/wNOCK/);
  });

  it("quote locked → seller", () => {
    const ev = step({}, { usdcLockTxHash: "0xq" });
    expect(ev).toHaveLength(1);
    expect(ev[0].recipientPkh).toBe("SELLER");
    expect(ev[0].title).toMatch(/locked/i);
  });

  it("withdraw (preimage reveal) → buyer", () => {
    const ev = step({}, { usdcWithdrawTxHash: "0xw" });
    expect(ev).toHaveLength(1);
    expect(ev[0].recipientPkh).toBe("BUYER");
    expect(ev[0].title).toMatch(/preimage/i);
  });

  it("NOCK claimed (complete) → seller", () => {
    const ev = step({}, { nockClaimTxId: "0xc" });
    expect(ev).toHaveLength(1);
    expect(ev[0].recipientPkh).toBe("SELLER");
    expect(ev[0].title).toMatch(/complete/i);
  });

  it("NOCK refund → buyer; quote refund → seller", () => {
    expect(step({}, { nockRefundTxId: "0xr" })[0].recipientPkh).toBe("BUYER");
    expect(step({}, { usdcRefundTxHash: "0xr" })[0].recipientPkh).toBe("SELLER");
  });

  it("no change → no events", () => {
    expect(step({ lockFirstName: "LFN" }, { lockFirstName: "LFN" })).toHaveLength(0);
  });

  it("multiple fields in one advance → multiple events", () => {
    const ev = step({}, { lockFirstName: "LFN", usdcLockTxHash: "0xq" });
    expect(ev.map((e) => e.recipientPkh).sort()).toEqual(["BUYER", "SELLER"]);
  });

  it("drops events with no recipient (open swap, no buyer yet)", () => {
    const ev = step({ buyerPkh: "" }, { buyerPkh: "", lockFirstName: "LFN" });
    expect(ev).toHaveLength(0);
  });
});
