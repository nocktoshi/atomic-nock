/**
 * Client sign-in: exchanges an Iris-signed challenge for a session token bound to
 * the wallet's pkh. The token (not any shared secret) authorizes writes.
 *
 * The token is persisted in localStorage and reused across reloads until it
 * actually expires (the Worker issues 7-day tokens), so the user signs once. No
 * secret is ever stored — the token only authorizes writes to that pkh's swaps.
 */
import type { NockWalletSession } from "../nock/wallet.js";
import { signMessageForWorker } from "../nock/sign.js";

const STORAGE_PREFIX = "atomicnock.session.";
/** Treat a token as expired this long before its real exp (clock skew / long ops). */
const EXPIRY_SKEW_MS = 5 * 60_000;

let activeWallet: NockWalletSession | null = null;
const inflight = new Map<string, Promise<string>>();

export function setActiveWallet(wallet: NockWalletSession | null): void {
  activeWallet = wallet;
}

export function getActiveWallet(): NockWalletSession | null {
  return activeWallet;
}

// --- localStorage helpers (no-throw; storage may be unavailable) -------------
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Read the `exp` (ms) baked into a session token, or null if unreadable. */
function tokenExpiry(token: string): number | null {
  try {
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const b64 = token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const { exp } = JSON.parse(atob(b64 + pad)) as { exp?: number };
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

function isFresh(token: string): boolean {
  const exp = tokenExpiry(token);
  return exp != null && exp - EXPIRY_SKEW_MS > Date.now();
}

/** A still-valid stored token for this pkh, or null (also evicts stale tokens). */
function storedToken(pkh: string): string | null {
  const key = STORAGE_PREFIX + pkh;
  const token = lsGet(key);
  if (!token) return null;
  if (isFresh(token)) return token;
  lsRemove(key);
  return null;
}

async function login(baseUrl: string, wallet: NockWalletSession): Promise<string> {
  const pkh = wallet.pkh as string;
  const chRes = await fetch(`${baseUrl}/auth/challenge?pkh=${encodeURIComponent(pkh)}`);
  if (!chRes.ok) throw new Error(`sign-in challenge failed (${chRes.status})`);
  const { challenge, challengeMac } = (await chRes.json()) as {
    challenge: string;
    challengeMac: string;
  };

  const { pubkeyHex, signature } = await signMessageForWorker(wallet, challenge);

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge, challengeMac, pubkeyHex, signature }),
  });
  if (!loginRes.ok) {
    const msg = await loginRes.text().catch(() => "");
    throw new Error(`sign-in failed (${loginRes.status}) ${msg}`);
  }
  const { token } = (await loginRes.json()) as { token: string };
  lsSet(STORAGE_PREFIX + pkh, token);
  return token;
}

/**
 * Return a valid bearer token for the active wallet, reusing the persisted token
 * if it's still fresh and signing in (one Iris popup) only when needed.
 * De-dupes concurrent sign-ins for the same pkh.
 */
export async function ensureSession(baseUrl: string): Promise<string> {
  const wallet = activeWallet;
  if (!wallet) throw new Error("Connect your Nockchain (Iris) wallet to continue");
  const pkh = wallet.pkh as string;

  const existing = storedToken(pkh);
  if (existing) return existing;

  let p = inflight.get(pkh);
  if (!p) {
    p = login(baseUrl, wallet).finally(() => inflight.delete(pkh));
    inflight.set(pkh, p);
  }
  return p;
}

/** Forget the persisted session (e.g. on disconnect). */
export function clearSession(pkh?: string): void {
  if (pkh) {
    lsRemove(STORAGE_PREFIX + pkh);
    return;
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
