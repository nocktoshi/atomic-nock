import { base58 } from "@scure/base";
import type { Digest } from "@nockchain/rose-ts";

export {
  giftOutputFirstNameFromLockOutputs,
  htlcGiftOutputFirstName,
  htlcLockRootDigest,
  htlcOrLock,
} from "@nockchain/rose-ts";

export const BASE58_DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{50,55}$/;
/** Any plausible base58 (for the "any long-decodable string" safety net). */
const BASE58_ANY_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** True when a crypto library already panicked (subsequent calls may fail). */
export function isRoseWasmPanic(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : String(err);
  return /panicked|unreachable|range start index.*out of range for slice of length 40/i.test(
    msg
  );
}

/** Decode base58 that should be a 40-byte Tip5 digest. */
export function decodeBase58DigestBytes(b58: string): Uint8Array | null {
  if (typeof b58 !== "string") return null;
  try {
    const bytes = base58.decode(b58);
    return bytes;
  } catch {
    return null;
  }
}

export function assertBase58Digest(label: string, val: unknown): asserts val is Digest {
  if (typeof val !== "string") throw new Error(`${label} must be a base58 string`);
  if (!BASE58_DIGEST_RE.test(val)) throw new Error(`${label} does not look like a base58 digest`);
  const bytes = decodeBase58DigestBytes(val);
  if (!bytes || bytes.length > 40) {
    throw new Error(`${label} decodes to ${bytes?.length ?? 0} bytes (max 40 for Tip5 digest)`);
  }
}

export function assertAllDigestsAnywhere(obj: unknown, where: string): void {
  const o = obj as Record<string, unknown> | null;
  if (o?.injectedBad) {
    throw new Error(`${where} injectedBad decodes to >40 bytes (max 40)`);
  }
  const walk = (v: unknown, p: string): void => {
    if (typeof v === "string") {
      if (/lock_root|first|last|id/i.test(p) && BASE58_ANY_RE.test(v) && v.length > 40) {
        const b = decodeBase58DigestBytes(v);
        if (!b || b.length > 40) {
          throw new Error(`${where} ${p} decodes to ${b?.length ?? "?"} bytes (> 40)`);
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (v && typeof v === "object") {
      Object.entries(v as Record<string, unknown>).forEach(([k, val]) =>
        walk(val, `${p}.${k}`)
      );
    }
  };
  walk(obj, where);
}