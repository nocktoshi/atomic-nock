/**
 * Friendly name resolution for address fields.
 * - .nock names → resolved via nocknames.com API
 * - .eth names  → resolved via ENS on Ethereum mainnet
 *
 * Returns the full address string to use in transactions; also returns the
 * display name so the UI can show the original friendly form.
 */
import { createPublicClient, http } from "viem";
import { normalize } from "viem/ens";
import { mainnet } from "viem/chains";
import { ETH_RPC_URL } from "../config.js";

const NOCKNAMES_API = "https://api.nocknames.com";

// Session-scoped caches — NNS and ENS bindings are stable within a page load.
// In-flight maps deduplicate concurrent requests for the same address (e.g. the
// same seller appearing in multiple marketplace cards at once).
const nockReverseCache = new Map<string, string>();
const nockReverseInflight = new Map<string, Promise<string>>();
const ensReverseCache = new Map<string, string>();
const ensReverseInflight = new Map<string, Promise<string>>();

// ENS lookups need a CORS-friendly mainnet RPC; retries off so a failed/no-ENS
// lookup doesn't spam the console (callers fall back to the raw address).
const ensClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC_URL || undefined, { retryCount: 0 }),
});

export interface ResolvedAddress {
  address: string;
  displayName: string;
}

/** True if the string looks like a .nock name. */
export function isNockName(s: string): boolean {
  return /^[a-zA-Z0-9_-]+\.nock$/i.test(s.trim());
}

/** True if the string looks like an ENS name. */
export function isEnsName(s: string): boolean {
  return /\.eth$/i.test(s.trim());
}

export async function resolveNockName(name: string): Promise<string> {
  const clean = name.trim().toLowerCase();
  const res = await fetch(`${NOCKNAMES_API}/resolve?name=${encodeURIComponent(clean)}`);
  if (!res.ok) throw new Error(`NockNames: ${res.status} ${res.statusText}`);
  const json = await res.json() as { address?: string };
  if (!json.address) throw new Error(`No address registered for ${name}`);
  return json.address;
}

export async function resolveEnsName(name: string): Promise<string> {
  const normalized = normalize(name.trim());
  const address = await ensClient.getEnsAddress({ name: normalized });
  if (!address) throw new Error(`No address registered for ${name}`);
  return address;
}

/**
 * Resolve a user-entered string to a full address.
 * Passes through full addresses unchanged.
 * Throws on resolution failure.
 */
export async function resolveAddress(input: string): Promise<ResolvedAddress> {
  const trimmed = input.trim();
  if (isNockName(trimmed)) {
    const address = await resolveNockName(trimmed);
    return { address, displayName: trimmed };
  }
  if (isEnsName(trimmed)) {
    const address = await resolveEnsName(trimmed);
    return { address, displayName: trimmed };
  }
  return { address: trimmed, displayName: trimmed };
}

/**
 * Reverse-resolve a Nockchain address to a .nock name, if one exists.
 * Returns the address itself if no name is found (never throws).
 * Results are cached for the session; concurrent calls for the same address
 * share a single in-flight request.
 */
export async function reverseResolveNock(address: string): Promise<string> {
  const key = address.trim();
  const hit = nockReverseCache.get(key);
  if (hit !== undefined) return hit;

  let p = nockReverseInflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`${NOCKNAMES_API}/resolve?address=${encodeURIComponent(key)}`);
        if (!res.ok) return key;
        const json = (await res.json()) as { name?: string };
        return json.name ?? key;
      } catch {
        return key;
      }
    })().then((name) => {
      nockReverseCache.set(key, name);
      return name;
    });
    nockReverseInflight.set(key, p);
    p.finally(() => nockReverseInflight.delete(key));
  }
  return p;
}

/**
 * Reverse-resolve an Ethereum address to an ENS name, if one exists.
 * Returns the address itself if no name is found (never throws).
 * Results are cached for the session; concurrent calls for the same address
 * share a single in-flight request.
 */
export async function reverseResolveEns(address: string): Promise<string> {
  const key = (address as string).trim().toLowerCase();
  const hit = ensReverseCache.get(key);
  if (hit !== undefined) return hit;

  let p = ensReverseInflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const name = await ensClient.getEnsName({ address: address as `0x${string}` });
        return name ?? address;
      } catch {
        return address;
      }
    })().then((name) => {
      ensReverseCache.set(key, name);
      return name;
    });
    ensReverseInflight.set(key, p);
    p.finally(() => ensReverseInflight.delete(key));
  }
  return p;
}
