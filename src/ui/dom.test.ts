import { describe, it, expect } from "vitest";
import { runBusy } from "./dom.js";

/** Minimal stand-in for a button so this stays a DOM-free logic test. */
function fakeButton() {
  const classes = new Set<string>();
  return {
    disabled: false,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      has: (c: string) => classes.has(c),
    },
    _classes: classes,
  };
}

describe("runBusy", () => {
  it("disables + marks busy while running, then restores on success", async () => {
    const b = fakeButton();
    const result = await runBusy(b as unknown as HTMLButtonElement, async () => {
      expect(b.disabled).toBe(true);
      expect(b._classes.has("busy")).toBe(true);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(b.disabled).toBe(false);
    expect(b._classes.has("busy")).toBe(false);
  });

  it("re-enables the button when the action throws (so the user can retry)", async () => {
    const b = fakeButton();
    await expect(
      runBusy(b as unknown as HTMLButtonElement, async () => {
        throw new Error("wallet rejected");
      })
    ).rejects.toThrow("wallet rejected");
    expect(b.disabled).toBe(false);
    expect(b._classes.has("busy")).toBe(false);
  });

  it("guards against a concurrent second run while one is in flight", async () => {
    const b = fakeButton();
    b.disabled = true; // simulate an action already running
    await expect(
      runBusy(b as unknown as HTMLButtonElement, async () => "x")
    ).rejects.toThrow("already in progress");
  });
});
