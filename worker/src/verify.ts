/**
 * Server-side Nockchain signature verification (the "sign-in" trust anchor).
 *
 * Runs the rose-wasm module inside the Worker. We verify two things:
 *   1. hashPublicKey(pubkeyBytes) === the pkh on record  (binds the key to the
 *      account whose fields are being changed), and
 *   2. verifySignature(pubkeyBytes, signature, message)   (proves key control).
 *
 * Both rose-wasm entry points take the *bytes* of the public key, so the Worker
 * never has to reconstruct a PublicKey object — only the Signature, from the
 * jam(signatureToNoun(sig)) the client sends.
 *
 * ⚠️ WIRE-FORMAT SEAM: the exact serialization the Iris extension returns from
 * `nock_signMessage` is confirmed on the client side (see the client adapter).
 * The Worker contract is fixed and minimal: hex(pubkey big-endian bytes) +
 * hex(jam(signatureToNoun(signature))). If the extension's encoding differs, the
 * adjustment happens in the client adapter, not here.
 */
import * as Rose from "@nockchain/rose-wasm";
// Wrangler turns a `.wasm` import into a compiled WebAssembly.Module.
import wasmModule from "@nockchain/rose-wasm/iris_wasm_bg.wasm";

let inited = false;
function ensureWasm(): void {
  if (inited) return;
  // New wasm-bindgen API takes `{ module }`; the module is already compiled.
  (Rose as unknown as { initSync(arg: { module: WebAssembly.Module }): void }).initSync({
    module: wasmModule as WebAssembly.Module,
  });
  inited = true;
}

export interface SignedAuth {
  /** The exact string that was signed (challenge — see session.ts). */
  message: string;
  /** hex of the base58-decoded public key bytes. */
  pubkeyHex: string;
  /** Schnorr signature scalars (little-endian hex), as rose-wasm verifies them. */
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
 *
 * Pass `expectedPkh = null` during the login challenge to learn *which* pkh
 * signed (the caller then decides the role); pass the on-record pkh to assert a
 * specific signer.
 */
export function verifyNockSignature(
  auth: SignedAuth,
  expectedPkh: string | null
): string | null {
  try {
    ensureWasm();
    const pubBytes = hexToBytes(auth.pubkeyHex);
    const pkh = Rose.hashPublicKey(pubBytes); // base58 Digest
    if (expectedPkh != null && pkh !== expectedPkh) return null;

    const ok = Rose.verifySignature(pubBytes, auth.signature, auth.message);
    return ok ? (pkh as string) : null;
  } catch {
    return null;
  }
}
