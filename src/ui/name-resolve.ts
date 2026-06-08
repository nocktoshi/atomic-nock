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

const NOCKNAMES_API = "https://api.nocknames.com";

const ensClient = createPublicClient({ chain: mainnet, transport: http() });

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
 * Reverse-resolve an address to a friendly name, if one exists.
 * Returns the address itself if no name is found (never throws).
 */
export async function reverseResolveNock(address: string): Promise<string> {
  try {
    const res = await fetch(`${NOCKNAMES_API}/resolve?address=${encodeURIComponent(address.trim())}`);
    if (!res.ok) return address;
    const json = await res.json() as { name?: string };
    return json.name ?? address;
  } catch {
    return address;
  }
}
