import { describe, it, expect } from "vitest";
import { byNewestSwap, swapCreatedAt } from "./util.js";

describe("swap newest-first ordering", () => {
  it("prefers the server createdAt stamp", () => {
    expect(swapCreatedAt({ createdAt: 50, usdcTimelock: 999n })).toBe(50);
  });

  it("falls back to the quote timelock for legacy records", () => {
    expect(swapCreatedAt({ usdcTimelock: 123n })).toBe(123);
    expect(swapCreatedAt({})).toBe(0);
  });

  it("sorts newest first across stamped and legacy records", () => {
    const a = { createdAt: 100 };
    const b = { usdcTimelock: 300n }; // legacy
    const c = { createdAt: 200 };
    expect([a, b, c].sort(byNewestSwap)).toEqual([b, c, a]);
  });
});
