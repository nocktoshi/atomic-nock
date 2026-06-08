import { describe, it, expect, vi } from "vitest";
import { WizardController } from "./wizard.js";

describe("WizardController", () => {
  it("clamps goto within bounds", () => {
    const c = new WizardController(3);
    c.goto(5);
    expect(c.index).toBe(2);
    c.goto(-3);
    expect(c.index).toBe(0);
  });

  it("back() stops at the first step", () => {
    const c = new WizardController(3);
    c.back();
    expect(c.index).toBe(0);
  });

  it("tryNext advances and clamps at the last step", async () => {
    const c = new WizardController(2);
    await c.tryNext();
    expect(c.index).toBe(1);
    await c.tryNext();
    expect(c.index).toBe(1);
  });

  it("runs the guard before advancing", async () => {
    const c = new WizardController(3);
    const guard = vi.fn(async () => {});
    await c.tryNext(guard);
    expect(guard).toHaveBeenCalledOnce();
    expect(c.index).toBe(1);
  });

  it("keeps the index unchanged when the guard throws", async () => {
    const c = new WizardController(3);
    const guard = vi.fn(async () => {
      throw new Error("validation failed");
    });
    await expect(c.tryNext(guard)).rejects.toThrow("validation failed");
    expect(c.index).toBe(0);
  });
});
