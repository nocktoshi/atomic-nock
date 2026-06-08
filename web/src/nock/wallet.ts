/**
 * Iris extension wallet — build with iris-wasm, sign via API 1 `nock_signTx`, send protobuf as-is.
 */
import { getGrpcWebUrl, formatGrpcError, formatWalletError } from "../grpc.js";
import { isPlausibleWalletAddress, noteNameKey } from "./balance.js";
import {
  isIrisWasmPanic,
} from "./tx.js";
import { Digest } from '@nockbox/iris-sdk/wasm'
import { resetIrisWasm } from "../iris.js";
import {
  getIrisWasm,
  initIrisWasm,
  DEFAULT_FEE_PER_WORD,
  type RawTxV1,
  type NockchainTx,
  type Note,
  type SpendCondition,
} from "../iris.js";
// rose-wasm (built from iris-rs with the structural-hax Witness::hash fix) is used
// for the tx-id calc so rawTxV1CalcId matches the node. @nockbox/iris-sdk's calc_id
// hashes the hax preimage with whole-noun varlen and produces the wrong id.
import { getRoseWasm } from "../rose.js";

/** Iris extension RPC API v1 (must match extension `RPC_API_VERSION`). */
const IRIS_RPC_API_V1 = "1.0.0";

/** Iris SDK provider methods (API 1). */
const IRIS_SIGN_TX = "nock_signTx";

/** True when witness carries an inlined hax preimage (protobuf `hax` or raw `hax_map`). */
function witnessHasHaxPreimage(witness: Record<string, unknown>): boolean {
  const hax = witness.hax;
  if (Array.isArray(hax) && hax.length > 0) {
    const ok = hax.some((entry) => {
      if (entry == null || typeof entry !== "object") return false;
      const e = entry as { hash?: unknown; value?: unknown };
      if (e.hash == null) return false;
      const v = e.value;
      if (v instanceof Uint8Array) return v.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") return v.length > 0;
      return v != null;
    });
    if (ok) return true;
  }
  const map = witness.hax_map as unknown;
  if (!Array.isArray(map) || map.length === 0) return false;
  return map.some((entry) => {
    if (entry == null) return false;
    const val = Array.isArray(entry) ? entry[1] : (entry as { value?: unknown }).value;
    if (val instanceof Uint8Array) return val.length > 0;
    if (Array.isArray(val)) return val.length > 0;
    return val != null;
  });
}

/** PKH sig required when the proved spend-condition includes %pkh (HTLC claim branch does). */
function witnessSpendNeedsPkhSig(witness: Record<string, unknown>): boolean {
  const lmp = witness.lock_merkle_proof as
    | { spend_condition?: { primitives?: Array<{ primitive?: Record<string, unknown> }> } }
    | undefined;
  const primitives = lmp?.spend_condition?.primitives ?? [];
  return primitives.some((p) => p.primitive != null && "Pkh" in p.primitive);
}

function witnessSpendNeedsHaxPreimage(witness: Record<string, unknown>): boolean {
  const lmp = witness.lock_merkle_proof as
    | { spend_condition?: { primitives?: Array<{ primitive?: Record<string, unknown> }> } }
    | undefined;
  const primitives = lmp?.spend_condition?.primitives ?? [];
  return primitives.some((p) => p.primitive != null && "Hax" in p.primitive);
}

function witnessPkhIsSigned(witness: Record<string, unknown>): boolean {
  const entries = (
    witness.pkh_signature as { entries?: Array<{ pubkey?: unknown; signature?: unknown }> }
  )?.entries ?? [];
  return entries.some((e) => e.pubkey != null && e.signature != null);
}

// NOTE: previous client-side tx-id workarounds (stripPkhSignatureOnHaxSpends,
// ensureCorrectHaxPreimageHashes) were removed. The id is now computed by rose-wasm's
// rawTxV1CalcId, whose Witness::hash hashes the hax preimage structurally (matching the
// node) and includes the pkh signature — so no client-side patching is needed, and the
// node accepts the declared id directly.

function analyzeWitnessSpendsInProtobuf(rawPb: Record<string, unknown>): {
  pkhNeed: number;
  pkhSigned: number;
  haxNeed: number;
  haxOk: number;
  unlockValid: boolean;
} {
  const spends = rawPb.spends;
  if (!Array.isArray(spends)) {
    return { pkhNeed: 0, pkhSigned: 0, haxNeed: 0, haxOk: 0, unlockValid: false };
  }

  let pkhNeed = 0;
  let pkhSigned = 0;
  let haxNeed = 0;
  let haxOk = 0;
  let unlockValid = true;

  for (const entry of spends) {
    if (entry == null || typeof entry !== "object") continue;
    const spend = (entry as { spend?: Record<string, unknown> }).spend;
    const spendKind = spend?.spend_kind;
    if (spendKind == null || typeof spendKind !== "object") continue;
    const witnessWrap = (spendKind as { Witness?: { witness?: Record<string, unknown> } })
      .Witness;
    const witness = witnessWrap?.witness;
    if (!witness || typeof witness !== "object") continue;

    const needsPkh = witnessSpendNeedsPkhSig(witness);
    const needsHax = witnessSpendNeedsHaxPreimage(witness);
    const hasHax = witnessHasHaxPreimage(witness);
    const hasPkh = needsPkh && witnessPkhIsSigned(witness);

    if (needsPkh) {
      pkhNeed++;
      if (hasPkh) pkhSigned++;
      else unlockValid = false;
    }
    if (needsHax) {
      haxNeed++;
      if (hasHax) haxOk++;
      else unlockValid = false;
    }
  }

  return { pkhNeed, pkhSigned, haxNeed, haxOk, unlockValid };
}

type GrpcRawTx = Parameters<
  InstanceType<Awaited<ReturnType<typeof getIrisWasm>>["GrpcClient"]>["sendTransaction"]
>[0];

/** Sign params for `nock_signTx` (native `NockchainTx` + optional input notes). */
export type IrisSignTxParams = {
  tx: NockchainTx;
  notes?: Note[];
};

/** Ensure that any hax preimages present in a built NockchainTx's witness_data are also
 * present directly in the per-spend witness.hax_map. The high-level TxBuilder + addPreimage
 * (via simpleSpend path) currently lands the data in witness_data; the wire form and the
 * Rust-side spend witness expect it on the individual spend so it serializes into the hax
 * list with value bytes for check:hax.
 */
export function ensureHaxPreimagesOnSpendWitnesses(tx: any): void {
  try {
    const wd = tx?.witness_data;
    const wdata = wd?.data ?? wd;
    if (!Array.isArray(wdata) || !Array.isArray(tx?.spends)) return;
    for (const entry of wdata) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const name = entry[0];
      const w = entry[1];
      const haxEntries = w?.hax_map;
      if (!Array.isArray(haxEntries) || haxEntries.length === 0) continue;
      for (const sp of tx.spends) {
        if (!Array.isArray(sp) || sp.length < 2) continue;
        const sname = sp[0];
        const sw = sp[1]?.witness ?? sp[1];
        if (sw && sname?.first === name?.first && sname?.last === name?.last) {
          if (!Array.isArray(sw.hax_map) || sw.hax_map.length === 0) {
            sw.hax_map = haxEntries;
          }
        }
      }
    }
  } catch {
    /* best effort */
  }
}

export type NockWalletProvider = {
  _isIrisWrapper?: boolean;
  connect(): Promise<{ pkh?: string; address?: string }>;
  /** API 1.0 — signs native `NockchainTx` (sign-only; we broadcast via gRPC). */
  signTx(params: IrisSignTxParams): Promise<NockchainTx>;
};

export type NockWalletSession = {
  pkh: Digest;
  address?: string;
  provider: NockWalletProvider;
  grpc: InstanceType<Awaited<ReturnType<typeof getIrisWasm>>["GrpcClient"]>;
};

declare global {
  interface Window {
    nockchain?: {
      request<T = unknown>(args: {
        method: string;
        params?: unknown;
        timeout?: number;
        api?: string;
      }): Promise<T>;
      on?(event: string, listener: (...args: unknown[]) => void): void;
      off?(event: string, listener: (...args: unknown[]) => void): void;
    };
  }
}

/**
 * Race a promise against a hard client-side deadline. The Iris extension can stop
 * responding entirely (message channel dies) and never resolve OR reject — which
 * leaves the calling button stuck disabled forever. This guarantees a rejection so
 * `runBusy`'s finally re-enables the button and the user can retry.
 */
function withTimeout<T>(p: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Iris ${method} timed out after ${Math.round(ms / 1000)}s — the extension may be ` +
              `unresponsive. Reopen/unlock Iris (or reload the extension) and try again.`
          )
        ),
      ms
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

async function irisRequest<T>(
  nockchain: NonNullable<Window["nockchain"]>,
  args: { method: string; params?: unknown; timeout?: number; api?: string }
): Promise<T> {
  try {
    // Grace beyond the RPC-declared timeout so a well-behaved extension can reject
    // first; this only fires if the extension is truly hung.
    const deadline = (args.timeout ?? 60_000) + 15_000;
    return await withTimeout(nockchain.request<T>(args), deadline, args.method);
  } catch (err) {
    console.error(`Iris ${args.method} rejected:`, err);
    if (err instanceof Error && err.cause != null) {
      console.error(`Iris ${args.method} cause:`, err.cause);
    }
    if (!(err instanceof Error)) {
      throw new Error(formatWalletError(err));
    }
    throw err;
  }
}

function unwrapSignedTxResponse(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result === "object") {
    if ("tx" in result) return (result as { tx: unknown }).tx;
    if ("rawTx" in result) return (result as { rawTx: unknown }).rawTx;
  }
  return result;
}

function coerceRpcBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((x) => typeof x === "number")
  ) {
    return new Uint8Array(value as number[]);
  }
  return value;
}

/** Each witness spend must have the unlocks it uses (hax preimage and/or PKH sig, not both blindly). */
function assertSignedProtobuf(rawPb: Record<string, unknown>): void {
  const { pkhNeed, pkhSigned, haxNeed, haxOk, unlockValid } =
    analyzeWitnessSpendsInProtobuf(rawPb);
  if (unlockValid) return;

  const parts: string[] = [];
  if (pkhNeed > 0 && pkhSigned < pkhNeed) {
    parts.push(`PKH signatures ${pkhSigned}/${pkhNeed}`);
  }
  if (haxNeed > 0 && haxOk < haxNeed) {
    parts.push(`hax preimages ${haxOk}/${haxNeed}`);
  }
  throw new Error(
    `Transaction unlocks incomplete (${parts.join("; ") || "witness spends"}). ` +
    `HTLC claim branch is [pkh AND hax] — you need the buyer PKH signature and the preimage jam. ` +
    `Unlock Iris, approve signing, and retry Claim NOCK.`
  );
}

async function waitTxAccepted(
  grpc: NockWalletSession["grpc"],
  txId: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await grpc.transactionAccepted(txId)) return true;
    } catch {
      /* node may lag */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function formatIrisSignFailure(err: unknown): string {
  const msg = formatWalletError(err);
  if (isIrisWasmPanic(err)) {
    return (
      `${msg} — iris-wasm panicked while decoding a Tip5 digest (invalid sellerPkh, lockFirstName, ` +
      `buyerPkh, or note name in swap JSON). Hard-reload this page (wasm is poisoned until reload), ` +
      `re-import seller swap JSON, then retry Claim NOCK.`
    );
  }
  return msg;
}

function createIrisProvider(nockchain: NonNullable<Window["nockchain"]>): NockWalletProvider {
  return {
    _isIrisWrapper: true,
    async connect() {
      try {
        const result = await irisRequest<
          { pkh?: string; address?: string } & Record<string, unknown>
        >(nockchain, {
          method: "nock_connect",
          timeout: 120_000,
        });
        return result;
      } catch (err) {
        throw new Error(`Iris nock_connect: ${formatWalletError(err)}`, { cause: err });
      }
    },
    async signTx(params) {
      const notes = params.notes ?? [];
      try {
        const result = await irisRequest<{ tx: NockchainTx }>(nockchain, {
          method: IRIS_SIGN_TX,
          params: { tx: params.tx, notes },
          api: IRIS_RPC_API_V1,
          timeout: 300_000,
        });
        const signed = unwrapSignedTxResponse(result);
        if (signed != null && typeof signed === "object") {
          return signed as NockchainTx;
        }
        throw new Error("Iris nock_signTx returned no signed transaction");
      } catch (err) {
        throw new Error(formatWalletError(err), { cause: err });
      }
    },
  };
}

export async function waitForIrisWallet(timeoutMs = 5000): Promise<NonNullable<Window["nockchain"]>> {
  if (window.nockchain?.request) return window.nockchain;

  return new Promise((resolve, reject) => {
    const deadline = window.setTimeout(() => {
      window.removeEventListener("nockchain#initialized", onInit);
      reject(
        new Error(
          "Iris wallet not found. Install the Iris extension and refresh this page."
        )
      );
    }, timeoutMs);

    const onInit = () => {
      if (window.nockchain?.request) {
        window.clearTimeout(deadline);
        window.removeEventListener("nockchain#initialized", onInit);
        resolve(window.nockchain);
      }
    };

    window.addEventListener("nockchain#initialized", onInit);
    onInit();
  });
}

export async function connectIrisWallet(): Promise<NockWalletSession> {
  await initIrisWasm();
  const Iris = await getIrisWasm();
  const injected = await waitForIrisWallet();
  const provider = createIrisProvider(injected);
  const raw = await provider.connect();
  const rawPkh = pickString(raw, ["pkh", "PKH"]) as Digest;
  if (!rawPkh) throw new Error("Iris connect did not return pkh");

  const address = isPlausibleWalletAddress(rawPkh)
    ? rawPkh
    : pickWalletAddress(raw);

  const grpc = new Iris.GrpcClient(getGrpcWebUrl());
  return {
    pkh: rawPkh,
    address,
    provider,
    grpc,
  };
}

function pickWalletAddress(
  obj: { pkh?: string; address?: string } & Record<string, unknown>
): string | undefined {
  for (const k of ["address", "walletAddress", "wallet_address", "account"]) {
    const v = obj[k];
    if (typeof v === "string" && isPlausibleWalletAddress(v)) return v.trim();
  }
  return undefined;
}

function pickString(
  obj: { pkh?: string; address?: string } & Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export type ClaimSignContext = {
  /** Input notes keyed by `noteNameKey` for `nock_signTx` (native iris-wasm `Note`). */
  noteByKey: Map<string, Note>;
  /** HTLC OR lock root — validated on the hax spend witness before broadcast. */
  htlcLockRoot?: Digest;
  /** Expected hNock digest — preimage jam must hash to this on the claim spend. */
  hNock?: Digest;
  /** Minimum origin-page among inputs (for post-bythos full LMP check). */
  minOriginPage?: bigint;
};

/**
 * Build → sign (`nock_signTx`) → canonicalize tx id from spends → gRPC send.
 *
 * Pass the native Notes that were supplied to simpleSpend / SpendBuilder so the
 * Iris extension can display the actual inputs in the "Sign Raw Transaction" dialog
 * and produce a correctly authorized spend. Without them you get "Inputs (0)".
 */
export async function signAndSendIrisTx(
  session: NockWalletSession,
  builder: InstanceType<Awaited<ReturnType<typeof getIrisWasm>>["TxBuilder"]>,
  inputNotes: Note[] = []
): Promise<string> {
  await initIrisWasm();
  const Iris = await getIrisWasm();

  let nockTx: NockchainTx;
  try {
    builder.recalcAndSetFee(false);
    nockTx = builder.build();

    // Force the birth source onto the spend's input name object (the thing that actually
    // gets serialized into the pb / raw tx). For HTLC notes created under an OR lock the
    // first-name derivation on the node requires the Source (Parent { parent, index }) that
    // was assigned when the note was emitted as an output of the seller's lock tx.
    if (inputNotes && inputNotes.length > 0 && nockTx.spends) {
      nockTx.spends.forEach((spend: any, i: number) => {
        if (i < inputNotes.length && spend && spend[0]) {
          const note = inputNotes[i] as any;
          const nameObj = spend[0];

          const src = note.source || (note.name && note.name.source);
          if (src) {
            if (!nameObj.source) nameObj.source = src;
            // Also write the Parent form in common alternative locations some noun/pb paths read
            if (!nameObj.Parent && src.Parent) nameObj.Parent = src.Parent;
            if (src.Parent) {
              nameObj.parent = src.Parent.parent ?? nameObj.parent;
              nameObj.birth_parent = src.Parent.parent ?? nameObj.birth_parent;
            }
          }

          const ph = note.parent_hash || (note.name && note.name.parent_hash) || (note.name && note.name.parent);
          if (ph && !nameObj.parent_hash) nameObj.parent_hash = ph;
          if (ph && !nameObj.parent) nameObj.parent = ph;

          // If the name object itself is the lockFirstName-ish thing and still lacks source, log it loudly.
          if (src && !nameObj.source && !nameObj.Parent) {
            console.warn('still no source/Parent after force patch on spend name:', nameObj);
          }
        }
      });
    }

  } catch (err) {
    const msg = String(err);
    if (msg.includes("Insufficient funds")) {
      throw new Error(
        `${msg} — fund buyer wallet with ~2+ NOCK for fees`
      );
    }
    throw new Error(`Tx build: ${formatGrpcError(err)}`);
  }

  // Make sure hax preimages added via builder.addPreimage end up on the per-spend witness
  // (not only in witness_data). See ensureHaxPreimagesOnSpendWitnesses.
  ensureHaxPreimagesOnSpendWitnesses(nockTx);
  if ((nockTx as any)?.witness_data?.data?.some((e: any) => e?.[1]?.hax_map?.length)) {
    console.debug("hax preimage present in nockTx (synced to spend witness)");
  }


  // Stash for debugging the exact nockTx shape the signer receives (spends, witness_data,
  // hax_map on the per-spend witness after our sync, etc.). This replaces the old
  // __lastClaimNockTx snapshot that was built from the claim path (which could trigger
  // aliasing panics on a later build()).
  (globalThis as any).__lastUnsignedNockTx = nockTx;
  console.debug("built unsigned nockTx (hax synced on spend witness; inspect __lastUnsignedNockTx)");
  const inputName = nockTx.spends?.[0]?.[0];
  console.log('unsigned nockTx input note name (spend[0][0] / the Name that must carry source for custom-firstName HTLC notes):', inputName);
  console.log('unsigned nockTx input note source on name:', (inputName as any)?.source);
  console.log('unsigned nockTx input note Parent on name:', (inputName as any)?.Parent || (inputName as any)?.parent);
  console.log('unsigned nockTx output seeds (each should have parent_hash = hash of the HTLC input note):', nockTx.spends?.[0]?.[1]?.seeds);

  let signedNockTx: NockchainTx;
  try {
    signedNockTx = await session.provider.signTx({
      tx: nockTx,
      notes: inputNotes,
    } as any);
  } catch (err) {
    if (isIrisWasmPanic(err)) {
      try {
        await resetIrisWasm();
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `Iris signing failed: ${formatIrisSignFailure(err)}. ` +
      `Unlock Iris, approve the popup (check it is not blocked), then retry Claim NOCK.`
    );
  }

  // Re-apply after the signer (it may have produced a new spends/witness shape with the
  // pkh_signature filled in). This guarantees the hax value is on the spend witness in the
  // object we convert to raw/pb.
  ensureHaxPreimagesOnSpendWitnesses(signedNockTx);

  // The extension may have computed a final id on the fully signed object (after pkh sigs).
  // Prefer it if present — it can be more consistent with the node's expectation than a
  // client-side raw calc (especially with hax preimages).
  const signedId = (signedNockTx as any)?.id;
  if (signedId) {
    console.debug("signedNockTx carried id:", signedId);
  }

  // After extension signing we always recompute + force the final id from the raw (see below)
  // and log the number of spends + whether hax preimage values are present on the wire form.
  // The extension mutates the tx (pkh sigs), and page-side addPreimage state must survive the
  // build/sign/serialize roundtrip for the hax to appear in the final bytes the node receives.
  let pb: any;
  let raw: any = null;
  // Use rose-wasm for the id calc: its Witness::hash hashes the hax preimage with
  // the STRUCTURAL hash-noun (matching the node's ++hash-noun), so rawTxV1CalcId
  // produces the exact id the node expects. (Do NOT strip the pkh signature — the
  // node includes pkh in the tx hash for every spend; stripping yields a wrong id.)
  const Rose: any = await getRoseWasm();
  raw = Rose.nockchainTxToRawTx(signedNockTx);

  const correctedId = Rose.rawTxV1CalcId(raw);
  (raw as any).id = correctedId;
  console.debug('txn id (rose rawTxV1CalcId): ', correctedId);

  pb = Rose.rawTxToProtobuf(raw);
  (pb as any).id = correctedId;

  const txId = (pb as any)?.id || "unknown-tx-id";

  console.debug('txn id (protobuf): ', txId);
  console.log('pb (raw, may not be fully serializable):', pb);
  console.dir(pb, { depth: 5 });

  await session.grpc.sendTransaction(pb);

  console.warn("broadcast txId", txId);

  console.debug(
    "If the node logs 'expected: <someId>' for a liar-effect, you can call " +
    "window.__resendWithCorrectId('<the expected id>') from the console to re-send the same tx bytes with the correct declared id."
  );

  const accepted = await waitTxAccepted(session.grpc, txId, 30_000);
  if (!accepted) {
    throw new Error(
      `Transaction not accepted within 30s (id ${txId}). ` +
      `If nockchain logs v1-spend-1-lock-failed or invalid transaction id, ` +
      `check the node log for an "expected: ..." value and call __resendWithCorrectId("that-id") from the console. ` +
      `Also confirm swap JSON (lockFirstName, lockRoot, hNock), reload Base preimage, hard-reload, retry.`
    );
  }

  return txId;
}
