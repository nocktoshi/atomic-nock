import { describe, it, expect, beforeEach } from "vitest";
import {
  getNockRpcOverride,
  setNockRpcOverride,
  isPlausibleRpcUrl,
} from "./settings.js";

// Minimal localStorage shim for the node test environment.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("nock RPC override", () => {
  it("defaults to empty (no override)", () => {
    expect(getNockRpcOverride()).toBe("");
  });

  it("set → get round-trips and trims", () => {
    setNockRpcOverride("  https://my-node.example.com  ");
    expect(getNockRpcOverride()).toBe("https://my-node.example.com");
  });

  it("clearing removes the override", () => {
    setNockRpcOverride("https://my-node.example.com");
    setNockRpcOverride(null);
    expect(getNockRpcOverride()).toBe("");
    setNockRpcOverride("https://x.example");
    setNockRpcOverride("");
    expect(getNockRpcOverride()).toBe("");
  });

  it("validates URL shape", () => {
    expect(isPlausibleRpcUrl("https://my-node.example.com:8080")).toBe(true);
    expect(isPlausibleRpcUrl("http://localhost:8080")).toBe(true);
    expect(isPlausibleRpcUrl("not a url")).toBe(false);
    expect(isPlausibleRpcUrl("ftp://x")).toBe(false);
  });
});
