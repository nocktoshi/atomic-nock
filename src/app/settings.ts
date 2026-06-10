/**
 * Client-side settings with a localStorage override layer. The Nockchain RPC
 * resolves as: localStorage override → VITE env → default. The override applies
 * instantly (even before sign-in); the signed-in profile keeps a synced copy so
 * other devices pick it up (see Settings.tsx).
 */

export const DEFAULT_NOCK_RPC = "https://rpc.nockchain.net";

const RPC_KEY = "atomicnock.nockRpcUrl";

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — override just won't persist */
  }
}

/** The user's custom Nockchain gRPC-Web endpoint, or "" when unset. */
export function getNockRpcOverride(): string {
  return (lsGet(RPC_KEY) ?? "").trim();
}

/** Set ("" or null clears) the custom Nockchain RPC. Takes effect on reload. */
export function setNockRpcOverride(url: string | null): void {
  const v = (url ?? "").trim();
  lsSet(RPC_KEY, v || null);
}

/** Loose sanity check; the endpoint must also be grpc-web + CORS-enabled. */
export function isPlausibleRpcUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim()) && url.trim().length <= 300;
}
