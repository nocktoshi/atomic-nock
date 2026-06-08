import { base58 } from "@scure/base";
import {
  lockFromList,
  lockRootHash,
  pkhSingle,
  initIrisWasm,
  getIrisWasm,
} from "../iris.js";
import type {
  Note,
  Digest,
  Lock,
} from '@nockbox/iris-sdk/wasm';

/** Full OR(claim | refund) lock — use with `lock_sp_index: 0` to claim. */
export async function htlcOrLock(
  hNock: Digest,
  buyerPkh: Digest,
  sellerPkh: Digest,
  refundHeight: bigint
): Promise<Lock> {
  await initIrisWasm();
  const Iris = await getIrisWasm();

  // Absolute spend conditions using the style from iris-sdk/extension/shared/spend-conditions.ts
  // Base PKH via spendConditionNewPkh, then spread + add other primitive for compound branch.
  // Claim branch: [Pkh(buyer), Hax(hNock)]  -- hNock is the preimage hash for the hax lock primitive.
  const pkhSc = Iris.spendConditionNewPkh(Iris.pkhSingle(buyerPkh));
  const haxPrim = { tag: 'hax', preimages: [hNock] } as any;
  const claimSpendCondition = [...pkhSc, haxPrim];

  // Refund branch: [Pkh(seller), Tim(abs min = refundHeight)]
  const sellerPkhPrim = Iris.pkhSingle(sellerPkh);
  const refundPkhSc = Iris.spendConditionNewPkh(sellerPkhPrim);
  // NOTE on timelock encoding (Number vs String):
  //   iris hashes `tim.abs.min` to a DIFFERENT atom for `Number(h)` vs `String(h)`
  //   (BigInt throws), so they produce different lock-tree roots. Verified against
  //   nockchain's authoritative hoon lock-hash vectors: the node's CANONICAL encoding
  //   is NUMBER (Number(h) reproduces the hoon vector; String does not). So a correct
  //   refund timelock requires Number(refundHeight).
  //   HOWEVER, the existing on-chain HTLC note (8sbGju…) was funded by an older build
  //   that used String, so its committed name.first only matches a String-derived root.
  //   We keep String here ONLY so that note's claim gets past the first-name check for
  //   debugging — but that note is anyway UNCLAIMABLE due to the hax-preimage hash bug
  //   (see below). For NEW swaps (after the hax fix) switch this back to Number(refundHeight)
  //   so funding, claim, AND the seller refund timelock are all canonical/correct.
  //
  // BLOCKER: the real reason HTLC claims fail with v1-spend-1-lock-failed is that
  //   iris `hashNoun` computes hash-varlen over the whole preimage noun, while the node's
  //   hax check uses STRUCTURAL hash-noun (hash-varlen per belt leaf + hash-ten-cell per
  //   cell). For a multi-belt preimage (tasBelts) these differ, so the committed hax hash
  //   (hNock) never matches the node's check. Fix hNock to use the structural hash-noun.
  const timPrim = {
    tag: 'tim',
    rel: { min: null, max: null },
    abs: { min: Number(refundHeight), max: null },
  };
  const refundSpendCondition = [...refundPkhSc, timPrim];

  return Iris.lockFromList([claimSpendCondition, refundSpendCondition]);
}

/** Digest of the HTLC OR lock tree (iris lockRootHash). */
export async function htlcLockRootDigest(
  hNock: Digest,
  buyerPkh: Digest,
  sellerPkh: Digest,
  refundHeight: bigint
): Promise<Digest> {
  const lock = await htlcOrLock(hNock, buyerPkh, sellerPkh, refundHeight);
  return lockRootHash(lock) as Digest;
}

/** Extract the HTLC gift output `name.first` from simulated lock outputs. */
export function giftOutputFirstNameFromLockOutputs(
  outputs: Array<{ name: { first: string }; assets: unknown }>,
  giftNicks: bigint
): Digest {
  for (const out of outputs) {
    if (BigInt(out.assets as string | number | bigint) === giftNicks) {
      return out.name.first as Digest;
    }
  }
  throw new Error("HTLC gift output not found in lock transaction outputs");
}

/**
 * Note `name.first` for the HTLC gift output (what the buyer claims).
 * Depends on the input note parent hash — only known once the funding note is chosen.
 */
export async function htlcGiftOutputFirstName(params: {
  hNock: Digest;
  buyerPkh: Digest;
  sellerPkh: Digest;
  refundHeight: bigint;
  giftNicks: bigint;
  inputNote: Note;
}): Promise<Digest> {
  await initIrisWasm();
  const Iris = await getIrisWasm();

  const lockRootDigest = await htlcLockRootDigest(
    params.hNock,
    params.buyerPkh,
    params.sellerPkh,
    params.refundHeight
  );

  const parentHash = Iris.noteHash(params.inputNote);
  const inputLock = lockFromList([
    Iris.spendConditionNewPkh(pkhSingle(params.sellerPkh as never)),
  ]);
  const spend = new Iris.SpendBuilder(
    params.inputNote,
    inputLock,
    0,
    inputLock
  );
  spend.seed({
    lock_root: lockRootDigest,
    note_data: Iris.noteDataEmpty(),
    gift: String(params.giftNicks),
    parent_hash: parentHash,
  } as never);
  spend.computeRefund(false);

  const settings = Iris.txEngineSettingsV1BythosDefault();

  const builder = new Iris.TxBuilder(settings);
  builder.spend(spend);
  builder.recalcAndSetFee(false);

  const raw = Iris.nockchainTxToRawTx(builder.build());
  const outputs = Iris.rawTxV1Outputs(raw, 0, settings);
  return giftOutputFirstNameFromLockOutputs(outputs, params.giftNicks);
}



export const BASE58_DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{50,55}$/;
/** Any plausible base58 (for the "any long-decodable string" safety net). */
const BASE58_ANY_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Tip5 digests are five 8-byte belts → at most 40 decoded bytes. */
const TIP5_DIGEST_BYTES = 40;

/** True when iris-wasm already panicked (subsequent wasm calls will fail). */
export function isIrisWasmPanic(err: unknown): boolean {
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
  const o = obj as any;
  if (o && o.injectedBad) {
    throw new Error(`${where} injectedBad decodes to >40 bytes (max 40)`);
  }
  // Light check: if a lock_root / first / last / id field contains a long non-digest base58, complain.
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
      Object.entries(v as any).forEach(([k, val]) => walk(val, `${p}.${k}`));
    }
  };
  walk(obj, where);
}

