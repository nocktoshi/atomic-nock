/**
 * User profiles: notification channels + client settings, keyed by nock pkh.
 * Profiles have NO TTL (unlike swaps) — they persist until the user changes them.
 *
 * Channel bindings (telegram/email/push) are managed by their own flows, never
 * by PUT /profile: the client may only update `prefs` and `settings` directly.
 */
import { SwapError, type Env } from "./swaps.js";

const PROFILE_PREFIX = "profile:";
const TGLINK_PREFIX = "tglink:";
const EMAILVERIFY_PREFIX = "emailverify:";
/** A telegram link / email verification code is valid this long. */
const LINK_CODE_TTL_SECONDS = 900;

/** Browser PushSubscription.toJSON() shape (also what web-push libs consume). */
export interface PushSub {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface Profile {
  /** Telegram binding (set via the /tg/webhook /start flow). */
  telegram?: { chatId: number; username?: string; linkedAt: number };
  /** Email binding (set via the verify flow; only verified addresses get mail). */
  email?: { address: string; verified: boolean };
  /** Web-push subscriptions (one per browser; set via /profile/push-subscribe). */
  push?: PushSub[];
  /** Per-channel opt-in. A channel notifies only when bound AND enabled. */
  prefs?: { telegram?: boolean; push?: boolean; email?: boolean };
  /** Client settings synced across devices. */
  settings?: { nockRpcUrl?: string };
}

/** Most browsers a single user plausibly notifies; prevents unbounded growth. */
const MAX_PUSH_SUBSCRIPTIONS = 5;

export async function loadProfile(env: Env, pkh: string): Promise<Profile> {
  const raw = await env.SWAPS.get(PROFILE_PREFIX + pkh);
  return raw ? (JSON.parse(raw) as Profile) : {};
}

export async function saveProfile(env: Env, pkh: string, profile: Profile): Promise<void> {
  await env.SWAPS.put(PROFILE_PREFIX + pkh, JSON.stringify(profile)); // no TTL
}

/** Apply a client PUT: only prefs + settings are writable; channels are not. */
export async function updateProfile(
  env: Env,
  pkh: string,
  body: { prefs?: unknown; settings?: unknown }
): Promise<Profile> {
  const prev = await loadProfile(env, pkh);
  const next: Profile = { ...prev };

  if (body.prefs != null) {
    if (typeof body.prefs !== "object") throw new SwapError(400, "bad prefs");
    const p = body.prefs as Record<string, unknown>;
    next.prefs = {
      telegram: Boolean(p.telegram),
      push: Boolean(p.push),
      email: Boolean(p.email),
    };
  }

  if (body.settings != null) {
    if (typeof body.settings !== "object") throw new SwapError(400, "bad settings");
    const s = body.settings as Record<string, unknown>;
    const url = typeof s.nockRpcUrl === "string" ? s.nockRpcUrl.trim() : "";
    if (url) {
      if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 300) {
        throw new SwapError(400, "nockRpcUrl must be an http(s) URL");
      }
      next.settings = { nockRpcUrl: url };
    } else {
      next.settings = {}; // explicit reset to default
    }
  }

  await saveProfile(env, pkh, next);
  return next;
}

/** Mint a short-lived code the user sends to the bot to bind their chat. */
export async function mintTelegramLinkCode(env: Env, pkh: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.SWAPS.put(TGLINK_PREFIX + code, pkh, {
    expirationTtl: LINK_CODE_TTL_SECONDS,
  });
  return code;
}

/** Redeem a /start code → pkh (and consume it). Null when unknown/expired. */
export async function redeemTelegramLinkCode(env: Env, code: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  const pkh = await env.SWAPS.get(TGLINK_PREFIX + code);
  if (pkh) await env.SWAPS.delete(TGLINK_PREFIX + code);
  return pkh;
}

export async function unlinkTelegram(env: Env, pkh: string): Promise<Profile> {
  const prev = await loadProfile(env, pkh);
  const next = { ...prev };
  delete next.telegram;
  await saveProfile(env, pkh, next);
  return next;
}

/**
 * Start email verification: store a 6-digit code (short TTL) for the address.
 * The caller emails the code; only `confirmEmailVerification` marks it usable.
 */
export async function requestEmailVerification(
  env: Env,
  pkh: string,
  address: string
): Promise<{ address: string; code: string }> {
  const email = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new SwapError(400, "enter a valid email address");
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.SWAPS.put(
    EMAILVERIFY_PREFIX + pkh,
    JSON.stringify({ address: email, code }),
    { expirationTtl: LINK_CODE_TTL_SECONDS }
  );
  return { address: email, code };
}

/** Confirm the 6-digit code → bind the verified address + enable the channel. */
export async function confirmEmailVerification(
  env: Env,
  pkh: string,
  code: string
): Promise<Profile> {
  const raw = await env.SWAPS.get(EMAILVERIFY_PREFIX + pkh);
  const pending = raw ? (JSON.parse(raw) as { address: string; code: string }) : null;
  if (!pending || pending.code !== code.trim()) {
    throw new SwapError(400, "wrong or expired code — request a new one");
  }
  await env.SWAPS.delete(EMAILVERIFY_PREFIX + pkh);
  const prev = await loadProfile(env, pkh);
  const next: Profile = {
    ...prev,
    email: { address: pending.address, verified: true },
    prefs: { ...prev.prefs, email: true },
  };
  await saveProfile(env, pkh, next);
  return next;
}

/** Drop the email binding. */
export async function removeEmail(env: Env, pkh: string): Promise<Profile> {
  const prev = await loadProfile(env, pkh);
  const next = { ...prev };
  delete next.email;
  await saveProfile(env, pkh, next);
  return next;
}

/** Validate a browser push subscription (PushSubscription.toJSON()). */
function asPushSub(raw: unknown): PushSub {
  const s = raw as Partial<PushSub> | null;
  const keys = s?.keys as Partial<PushSub["keys"]> | undefined;
  if (
    !s ||
    typeof s.endpoint !== "string" ||
    !/^https:\/\//.test(s.endpoint) ||
    s.endpoint.length > 1024 ||
    typeof keys?.p256dh !== "string" ||
    typeof keys?.auth !== "string"
  ) {
    throw new SwapError(400, "bad push subscription");
  }
  return {
    endpoint: s.endpoint,
    expirationTime: typeof s.expirationTime === "number" ? s.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

/** Register a browser's push subscription (idempotent per endpoint, capped). */
export async function addPushSubscription(
  env: Env,
  pkh: string,
  raw: unknown
): Promise<Profile> {
  const sub = asPushSub(raw);
  const prev = await loadProfile(env, pkh);
  const others = (prev.push ?? []).filter((p) => p.endpoint !== sub.endpoint);
  const next: Profile = {
    ...prev,
    push: [...others, sub].slice(-MAX_PUSH_SUBSCRIPTIONS),
    prefs: { ...prev.prefs, push: true },
  };
  await saveProfile(env, pkh, next);
  return next;
}

/** Drop one browser's subscription by endpoint ("" / unknown is a no-op). */
export async function removePushSubscription(
  env: Env,
  pkh: string,
  endpoint: string
): Promise<Profile> {
  const prev = await loadProfile(env, pkh);
  const next: Profile = {
    ...prev,
    push: (prev.push ?? []).filter((p) => p.endpoint !== endpoint),
  };
  await saveProfile(env, pkh, next);
  return next;
}
