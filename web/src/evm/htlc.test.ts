import { describe, it, expect } from "vitest";
import { toAtomic, parseUsdc } from "./htlc.js";

describe("toAtomic", () => {
  it("scales a 6-decimal token (real Base USDC)", () => {
    expect(toAtomic("1.0", 6)).toBe(1_000_000n);
    expect(toAtomic("1", 6)).toBe(1_000_000n);
    expect(toAtomic("0.5", 6)).toBe(500_000n);
    expect(toAtomic("2.5", 6)).toBe(2_500_000n);
  });

  it("scales an 18-decimal token (e.g. a mock USDC in a test deployment)", () => {
    // This is the case that previously displayed as <0.000001 in the wallet:
    // 1e6 atomic units of an 18-decimal token is 0.000000000001 tokens.
    expect(toAtomic("1.0", 18)).toBe(10n ** 18n);
  });

  it("truncates fractional digits beyond the token's precision", () => {
    expect(toAtomic("1.23456789", 6)).toBe(1_234_567n);
  });

  it("parseUsdc stays pinned to 6 decimals", () => {
    expect(parseUsdc("1.0")).toBe(1_000_000n);
  });
});
