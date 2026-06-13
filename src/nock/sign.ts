/**
 * Adapter: Rose `nock_signMessage` response → the Worker's verification wire
 * format ({ pubkeyHex, signature }).
 */
import { base58 } from "@scure/base";
import { hashPublicKey, verifySignature } from "@nockchain/rose-ts";
import type { NockWalletSession, RawSignMessageResponse } from "./wallet.js";

/** Schnorr signature scalars, as verifySignature expects them. */
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
    return base58.decode(t);
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const inner = o.bytes ?? o.data ?? o.value;
    if (inner != null) return decodeAtom(inner, field);
  }
  console.error(`[sign] cannot decode ${field} from nock_signMessage:`, v);
  throw new Error(`Unrecognized ${field} format from Rose nock_signMessage (see console).`);
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
  throw new Error("Unrecognized signature format from Rose nock_signMessage (see console).");
}

/** Sign `message` with the connected Rose wallet and return the Worker wire form. */
export async function signMessageForWorker(
  wallet: NockWalletSession,
  message: string
): Promise<SignedWire> {
  const raw: RawSignMessageResponse = await wallet.provider.signMessage(message);

  const pubBytes = decodeAtom(raw.publicKey, "publicKey");
  const signature = toSignature(raw.signature);

  try {
    const derivedPkh = String(hashPublicKey(pubBytes));
    if (wallet.pkh && derivedPkh !== String(wallet.pkh)) {
      console.warn(
        `[sign] pubkey hashes to ${derivedPkh} but wallet pkh is ${wallet.pkh} — ` +
        `the Worker's pkh binding will reject this.`
      );
    }
    if (!verifySignature(pubBytes, signature, message)) {
      console.warn(
        "[sign] local verifySignature(message) failed — the Worker will reject it too."
      );
    }
  } catch (e) {
    console.warn("[sign] local signature self-check could not run:", e);
  }

  return { pubkeyHex: bytesToHex(pubBytes), signature };
}