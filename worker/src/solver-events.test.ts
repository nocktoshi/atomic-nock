import { describe, it, expect } from "vitest";
import { rfqCreated, swapUpdated, commandFailed } from "./solver-events.js";

describe("solver-events", () => {
  it("builds stable rfq.created ids", () => {
    const e = rfqCreated("abc", "buy", "10");
    expect(e.type).toBe("rfq.created");
    expect(e.id).toBe("rfq.created:abc:0");
  });

  it("includes swap version in swap.updated id", () => {
    const e = swapUpdated({
      hEvm: "0xAbC",
      version: 3,
    } as Parameters<typeof swapUpdated>[0]);
    expect(e.id).toBe("swap.updated:0xabc:3");
    if (e.type === "swap.updated") expect(e.version).toBe(3);
  });

  it("carries command failure metadata", () => {
    const e = commandFailed("cmd-1", "swap.claim", 409, "already claimed");
    expect(e.type).toBe("command.failed");
    if (e.type === "command.failed") {
      expect(e.commandId).toBe("cmd-1");
      expect(e.code).toBe(409);
    }
  });
});