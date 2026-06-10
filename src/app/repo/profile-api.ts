/**
 * Authenticated client for the Worker's profile endpoints (notification
 * channels + synced settings). Requires a deployed/local Worker — in pure
 * in-memory dev mode these throw a clear error; the RPC override still works
 * because it lives in localStorage (see app/settings.ts).
 */
import { KV_URL } from "../../config.js";
import { ensureSession } from "../auth.js";

export interface Profile {
  telegram?: { chatId: number; username?: string; linkedAt: number };
  email?: { address: string; verified: boolean };
  push?: unknown[];
  prefs?: { telegram?: boolean; push?: boolean; email?: boolean };
  settings?: { nockRpcUrl?: string };
}

function requireApi(): string {
  if (!KV_URL) {
    throw new Error(
      "Profile features need the swap API — set VITE_KV_URL (run the local worker in dev)"
    );
  }
  return KV_URL;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const baseUrl = requireApi();
  const token = await ensureSession(baseUrl);
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body != null ? { "content-type": "application/json" } : {}),
    },
    ...(init.body != null ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let msg = "";
    try {
      msg = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(msg || `profile request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function getProfile(): Promise<Profile> {
  return request<Profile>("/profile");
}

export function putProfile(update: {
  prefs?: Profile["prefs"];
  settings?: Profile["settings"];
}): Promise<Profile> {
  return request<Profile>("/profile", { method: "PUT", body: update });
}

export function telegramLinkCode(): Promise<{ code: string; bot: string; url: string }> {
  return request("/profile/telegram/link-code", { method: "POST", body: {} });
}

export function telegramUnlink(): Promise<Profile> {
  return request<Profile>("/profile/telegram/unlink", { method: "POST", body: {} });
}

/** Register this browser's PushSubscription.toJSON() on the profile. */
export function pushSubscribe(subscription: unknown): Promise<Profile> {
  return request<Profile>("/profile/push-subscribe", {
    method: "POST",
    body: { subscription },
  });
}

/** Remove one browser's subscription from the profile by endpoint. */
export function pushUnsubscribe(endpoint: string): Promise<Profile> {
  return request<Profile>("/profile/push-unsubscribe", {
    method: "POST",
    body: { endpoint },
  });
}

/** Start email verification — the worker emails a 6-digit code. */
export function emailRequest(address: string): Promise<{ ok: boolean; address: string }> {
  return request("/profile/email", { method: "POST", body: { address } });
}

/** Confirm the emailed code; binds the verified address. */
export function emailVerify(code: string): Promise<Profile> {
  return request<Profile>("/profile/email/verify", { method: "POST", body: { code } });
}

export function emailRemove(): Promise<Profile> {
  return request<Profile>("/profile/email/remove", { method: "POST", body: {} });
}
