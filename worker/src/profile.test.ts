import { describe, it, expect } from "vitest";
import {
  loadProfile,
  updateProfile,
  mintTelegramLinkCode,
  redeemTelegramLinkCode,
  unlinkTelegram,
  saveProfile,
  addPushSubscription,
  removePushSubscription,
  requestEmailVerification,
  confirmEmailVerification,
  removeEmail,
} from "./profile.js";
import type { Env } from "./swaps.js";

function fakeEnv(): Env & { putOpts: Map<string, unknown> } {
  const store = new Map<string, string>();
  const putOpts = new Map<string, unknown>();
  const SWAPS = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: unknown) => {
      store.set(k, v);
      putOpts.set(k, opts);
    },
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  };
  return { SWAPS, putOpts } as unknown as Env & { putOpts: Map<string, unknown> };
}

describe("profile", () => {
  it("loads an empty profile for an unknown pkh", async () => {
    expect(await loadProfile(fakeEnv(), "PKH")).toEqual({});
  });

  it("PUT updates prefs + settings and persists them WITHOUT a TTL", async () => {
    const env = fakeEnv();
    const p = await updateProfile(env, "PKH", {
      prefs: { telegram: true },
      settings: { nockRpcUrl: "https://my-node.example.com" },
    });
    expect(p.prefs?.telegram).toBe(true);
    expect(p.settings?.nockRpcUrl).toBe("https://my-node.example.com");
    expect(env.putOpts.get("profile:PKH")).toBeUndefined(); // profiles never expire
    expect((await loadProfile(env, "PKH")).settings?.nockRpcUrl).toBe(
      "https://my-node.example.com"
    );
  });

  it("rejects a non-URL nockRpcUrl", async () => {
    await expect(
      updateProfile(fakeEnv(), "PKH", { settings: { nockRpcUrl: "not a url" } })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("empty nockRpcUrl resets to default", async () => {
    const env = fakeEnv();
    await updateProfile(env, "PKH", { settings: { nockRpcUrl: "https://x.example" } });
    const p = await updateProfile(env, "PKH", { settings: { nockRpcUrl: "" } });
    expect(p.settings?.nockRpcUrl).toBeUndefined();
  });

  it("PUT cannot write channel bindings directly", async () => {
    const env = fakeEnv();
    await updateProfile(env, "PKH", {
      prefs: { telegram: true },
      // attacker-style extra junk is simply ignored by the typed update path
      ...({ telegram: { chatId: 666 } } as object),
    });
    expect((await loadProfile(env, "PKH")).telegram).toBeUndefined();
  });

  it("telegram link code round-trips once and is consumed", async () => {
    const env = fakeEnv();
    const code = await mintTelegramLinkCode(env, "PKH");
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(await redeemTelegramLinkCode(env, code)).toBe("PKH");
    expect(await redeemTelegramLinkCode(env, code)).toBeNull(); // consumed
  });

  it("rejects malformed link codes without a KV read", async () => {
    expect(await redeemTelegramLinkCode(fakeEnv(), "../profile:PKH")).toBeNull();
  });

  it("push subscribe is idempotent per endpoint and enables the pref", async () => {
    const env = fakeEnv();
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      expirationTime: null,
      keys: { p256dh: "P", auth: "A" },
    };
    await addPushSubscription(env, "PKH", sub);
    const p = await addPushSubscription(env, "PKH", sub); // same endpoint again
    expect(p.push).toHaveLength(1);
    expect(p.prefs?.push).toBe(true);
  });

  it("push subscribe rejects malformed subscriptions", async () => {
    await expect(
      addPushSubscription(fakeEnv(), "PKH", { endpoint: "http://insecure", keys: {} })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("push unsubscribe removes only the given endpoint", async () => {
    const env = fakeEnv();
    const mk = (n: string) => ({
      endpoint: `https://push.example/${n}`,
      expirationTime: null,
      keys: { p256dh: "P", auth: "A" },
    });
    await addPushSubscription(env, "PKH", mk("one"));
    await addPushSubscription(env, "PKH", mk("two"));
    const p = await removePushSubscription(env, "PKH", "https://push.example/one");
    expect(p.push?.map((s) => s.endpoint)).toEqual(["https://push.example/two"]);
  });

  it("unlink drops only the telegram binding", async () => {
    const env = fakeEnv();
    await saveProfile(env, "PKH", {
      telegram: { chatId: 1, linkedAt: 0 },
      prefs: { telegram: true },
    });
    const p = await unlinkTelegram(env, "PKH");
    expect(p.telegram).toBeUndefined();
    expect(p.prefs?.telegram).toBe(true);
  });

  it("email verification: code round-trip binds a verified address", async () => {
    const env = fakeEnv();
    const { address, code } = await requestEmailVerification(env, "PKH", " Mark@Example.COM ");
    expect(address).toBe("mark@example.com");
    expect(code).toMatch(/^\d{6}$/);
    expect(env.putOpts.get("emailverify:PKH")).toMatchObject({ expirationTtl: 900 });

    const p = await confirmEmailVerification(env, "PKH", code);
    expect(p.email).toEqual({ address: "mark@example.com", verified: true });
    expect(p.prefs?.email).toBe(true);
    // Code consumed — a replay fails.
    await expect(confirmEmailVerification(env, "PKH", code)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("email verification rejects bad addresses and wrong codes", async () => {
    const env = fakeEnv();
    await expect(
      requestEmailVerification(env, "PKH", "not-an-email")
    ).rejects.toMatchObject({ status: 400 });
    await requestEmailVerification(env, "PKH", "a@b.co");
    await expect(confirmEmailVerification(env, "PKH", "000000x")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("removeEmail drops the binding", async () => {
    const env = fakeEnv();
    const { code } = await requestEmailVerification(env, "PKH", "a@b.co");
    await confirmEmailVerification(env, "PKH", code);
    const p = await removeEmail(env, "PKH");
    expect(p.email).toBeUndefined();
  });
});
