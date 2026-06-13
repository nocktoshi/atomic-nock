/**
 * Server-side Nockchain signature verification (the "sign-in" trust anchor).
 */
import { hashPublicKey, verifySignature } from "@nockchain/rose-ts";

export interface SignedAuth {
  /** The exact string that was signed (challenge — see session.ts). */
  message: string;
  /** hex of the base58-decoded public key bytes. */
  pubkeyHex: string;
  /** Schnorr signature scalars (little-endian hex). */
  signature: { c: string; s: string };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Returns the verified base58 pkh if the signature is valid AND the public key
 * hashes to `expectedPkh` (when provided). Returns null on any failure.
 */
export function verifyNockSignature(
  auth: SignedAuth,
  expectedPkh: string | null
): string | null {
  try {
    const pubBytes = hexToBytes(auth.pubkeyHex);
    const pkh = hashPublicKey(pubBytes);
    if (expectedPkh != null && pkh !== expectedPkh) return null;

    const ok = verifySignature(pubBytes, auth.signature, auth.message);
    return ok ? (pkh as string) : null;
  } catch {
    return null;
  }
}