/**
 * Adapter: Iris `nock_signMessage` response → the Worker's verification wire
 * format ({ pubkeyHex, signature }).
 *
 * Confirmed shapes (from a real Iris signing):
 *   publicKey = base58 string  → decode to the raw pubkey bytes (hex on the wire)
 *   signature = { c, s }       → a Schnorr signature (little-endian hex scalars);
 *                                rose-wasm's verifySignature takes this object as-is.
 *
 * We self-check client-side with the exact rose-wasm calls the Worker runs, so a
 * mismatch surfaces here (clear console diagnostics) instead of as an opaque 401.
 */
import { base58 } from "@scure/base";
import type { NockWalletSession, RawSignMessageResponse } from "./wallet.js";
import { getRoseWasm } from "../rose.js";

/** Schnorr signature scalars, as rose-wasm's verifySignature expects them. */
export interface NockSignature {
  c: string;
  s: string;
}

export interface SignedWire {
  pubkeyHex: string;
  signature: NockSignature;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decode a hex / base58 / byte-array value into raw bytes. */
function decodeAtom(v: unknown, field: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
    return Uint8Array.from(v as number[]);
  }
  if (typeof v === "string") {
    const t = v.trim();
    const hex = t.startsWith("0x") ? t.slice(2) : t;
    if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
      return hexToBytes(hex);
    }
    return base58.decode(t); // base58 (the format Iris returns)
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const inner = o.bytes ?? o.data ?? o.value;
    if (inner != null) return decodeAtom(inner, field);
  }
  console.error(`[sign] cannot decode ${field} from nock_signMessage:`, v);
  throw new Error(`Unrecognized ${field} format from Iris nock_signMessage (see console).`);
}

/** Pull the { c, s } Schnorr scalars out of the raw signature value. */
function toSignature(v: unknown): NockSignature {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.c === "string" && typeof o.s === "string") {
      return { c: o.c, s: o.s };
    }
  }
  console.error("[sign] cannot read { c, s } from signature:", v);
  throw new Error("Unrecognized signature format from Iris nock_signMessage (see console).");
}

/** Sign `message` with the connected Iris wallet and return the Worker wire form. */
export async function signMessageForWorker(
  wallet: NockWalletSession,
  message: string
): Promise<SignedWire> {
  const raw: RawSignMessageResponse = await wallet.provider.signMessage(message);
  const Rose = await getRoseWasm();

  const pubBytes = decodeAtom(raw.publicKey, "publicKey");
  const signature = toSignature(raw.signature);

  // Self-check with the exact rose-wasm logic the Worker runs.
  try {
    const derivedPkh = String(Rose.hashPublicKey(pubBytes));
    if (wallet.pkh && derivedPkh !== String(wallet.pkh)) {
      console.warn(
        `[sign] pubkey hashes to ${derivedPkh} but wallet pkh is ${wallet.pkh} — ` +
          `the Worker's pkh binding will reject this.`
      );
    }
    if (!Rose.verifySignature(pubBytes, signature, message)) {
      console.warn(
        "[sign] local verifySignature(message) failed — the Worker will reject it too."
      );
    }
  } catch (e) {
    console.warn("[sign] local signature self-check could not run:", e);
  }

  return { pubkeyHex: bytesToHex(pubBytes), signature };
}
