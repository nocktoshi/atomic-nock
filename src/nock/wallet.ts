/**
 * Iris extension wallet — build with iris-wasm, sign via API 1 `nock_signTx`, send protobuf as-is.
 */
import { getGrpcWebUrl, formatGrpcError, formatWalletError } from "../grpc.js";
import { isPlausibleWalletAddress } from "./balance.js";
import {
  isIrisWasmPanic,
} from "./tx.js";
import { Digest } from '@nockbox/iris-sdk/wasm'
import { resetIrisWasm } from "../iris.js";
import {
  getIrisWasm,
  initIrisWasm,
  type NockchainTx,
  type Note,
} from "../iris.js";
// rose-wasm (built from iris-rs with the structural-hax Witness::hash fix) is used
// for the tx-id calc so rawTxV1CalcId matches the node. @nockbox/iris-sdk's calc_id
// hashes the hax preimage with whole-noun varlen and produces the wrong id.
import { getRoseWasm } from "../rose.js";
import type { PbCom2RawTransaction, RawTxV1 } from "@nockchain/rose-wasm";


/** Iris extension RPC API v1 (must match extension `RPC_API_VERSION`). */
const IRIS_RPC_API_V1 = "1.0.0";

/** Iris SDK provider methods (API 1). */
const IRIS_SIGN_TX = "nock_signTx";


// NOTE: previous client-side tx-id workarounds (stripPkhSignatureOnHaxSpends,
// ensureCorrectHaxPreimageHashes) were removed. The id is now computed by rose-wasm's
// rawTxV1CalcId, whose Witness::hash hashes the hax preimage structurally (matching the
// node) and includes the pkh signature — so no client-side patching is needed, and the
// node accepts the declared id directly.

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
type MutableRecord = Record<string, unknown>;

function asMutable(value: unknown): MutableRecord {
  return value as unknown as MutableRecord;
}

export function ensureHaxPreimagesOnSpendWitnesses(tx: NockchainTx): void {
  try {
    const txRec = tx as NockchainTx & MutableRecord;
    const wd = txRec.witness_data
      ? asMutable(txRec.witness_data)
      : undefined;
    const wdata = (wd?.data ?? wd) as unknown;
    if (!Array.isArray(wdata) || !Array.isArray(txRec.spends)) return;
    for (const entry of wdata) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const name = asMutable(entry[0]);
      const w = asMutable(entry[1]);
      const haxEntries = w.hax_map;
      if (!Array.isArray(haxEntries) || haxEntries.length === 0) continue;
      for (const sp of txRec.spends) {
        if (!Array.isArray(sp) || sp.length < 2) continue;
        const sname = asMutable(sp[0]);
        const spendBody = asMutable(sp[1]);
        const sw = asMutable(spendBody.witness ?? spendBody);
        if (
          sw &&
          sname.first === name.first &&
          sname.last === name.last &&
          (!Array.isArray(sw.hax_map) || sw.hax_map.length === 0)
        ) {
          sw.hax_map = haxEntries;
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
      throw new Error(formatWalletError(err), { cause: err });
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
  wallet: NockWalletSession,
  builder: InstanceType<Awaited<ReturnType<typeof getIrisWasm>>["TxBuilder"]>,
  inputNotes: Note[] = []
): Promise<string> {
  await initIrisWasm();

  let nockTx: NockchainTx;
  try {
    builder.recalcAndSetFee(false);
    nockTx = builder.build();

    // Force the birth source onto the spend's input name object (the thing that actually
    // gets serialized into the pb / raw tx). For HTLC notes created under an OR lock the
    // first-name derivation on the node requires the Source (Parent { parent, index }) that
    // was assigned when the note was emitted as an output of the seller's lock tx.
    if (inputNotes && inputNotes.length > 0 && nockTx.spends) {
      nockTx.spends.forEach((spend, i) => {
        if (i >= inputNotes.length || !Array.isArray(spend) || !spend[0]) return;
        const note = asMutable(inputNotes[i]) as Note & MutableRecord;
        const nameObj = asMutable(spend[0]);
        const noteName = note.name ? asMutable(note.name) : undefined;

        const src = note.source ?? noteName?.source;
        if (src && typeof src === "object") {
          const srcRec = asMutable(src);
          if (!nameObj.source) nameObj.source = src;
          const parent = srcRec.Parent ? asMutable(srcRec.Parent) : undefined;
          if (!nameObj.Parent && parent) nameObj.Parent = parent;
          if (parent) {
            const parentId = parent.parent;
            if (parentId != null) {
              nameObj.parent ??= parentId;
              nameObj.birth_parent ??= parentId;
            }
          }
        }

        const ph =
          note.parent_hash ?? noteName?.parent_hash ?? noteName?.parent;
        if (ph != null) {
          nameObj.parent_hash ??= ph;
          nameObj.parent ??= ph;
        }

        if (src && !nameObj.source && !nameObj.Parent) {
          console.warn("still no source/Parent after force patch on spend name:", nameObj);
        }
      });
    }

  } catch (err) {
    const msg = String(err);
    if (msg.includes("Insufficient funds")) {
      throw new Error(`${msg} — fund buyer wallet with ~2+ NOCK for fees`, {
        cause: err,
      });
    }
    throw new Error(`Tx build: ${formatGrpcError(err)}`, { cause: err });
  }

  // Make sure hax preimages added via builder.addPreimage end up on the per-spend witness
  // (not only in witness_data). See ensureHaxPreimagesOnSpendWitnesses.
  ensureHaxPreimagesOnSpendWitnesses(nockTx);
  const witnessData = (nockTx as NockchainTx & MutableRecord).witness_data
    ? asMutable((nockTx as NockchainTx & MutableRecord).witness_data)
    : undefined;
  if (
    Array.isArray(witnessData?.data) &&
    witnessData.data.some((e: unknown) => {
      if (!Array.isArray(e) || e.length < 2) return false;
      const w = asMutable(e[1]);
      return Array.isArray(w.hax_map) && w.hax_map.length > 0;
    })
  ) {
    console.debug("hax preimage present in nockTx (synced to spend witness)");
  }

  // Stash for debugging the exact nockTx shape the signer receives.
  (globalThis as typeof globalThis & { __lastUnsignedNockTx?: NockchainTx }).__lastUnsignedNockTx =
    nockTx;
  console.debug("built unsigned nockTx (hax synced on spend witness; inspect __lastUnsignedNockTx)");
  const inputName = nockTx.spends?.[0]?.[0]
    ? asMutable(nockTx.spends[0][0])
    : undefined;
  console.log(
    "unsigned nockTx input note name (spend[0][0] / the Name that must carry source for custom-firstName HTLC notes):",
    inputName
  );
  console.log("unsigned nockTx input note source on name:", inputName?.source);
  console.log(
    "unsigned nockTx input note Parent on name:",
    inputName?.Parent ?? inputName?.parent
  );
  const firstSpend = nockTx.spends?.[0]?.[1]
    ? asMutable(nockTx.spends[0][1])
    : undefined;
  console.log(
    "unsigned nockTx output seeds (each should have parent_hash = hash of the HTLC input note):",
    firstSpend?.seeds
  );

  let signedNockTx: NockchainTx;
  try {
    signedNockTx = await wallet.provider.signTx({
      tx: nockTx,
      notes: inputNotes,
    });
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
        `Unlock Iris, approve the popup (check it is not blocked), then retry Claim NOCK.`,
      { cause: err }
    );
  }

  // Re-apply after the signer (it may have produced a new spends/witness shape with the
  // pkh_signature filled in). This guarantees the hax value is on the spend witness in the
  // object we convert to raw/pb.
  ensureHaxPreimagesOnSpendWitnesses(signedNockTx);

  // The extension may have computed a final id on the fully signed object (after pkh sigs).
  // Prefer it if present — it can be more consistent with the node's expectation than a
  // client-side raw calc (especially with hax preimages).
  const signedId = (signedNockTx as NockchainTx & MutableRecord).id;
  if (signedId) {
    console.debug("signedNockTx carried id:", signedId);
  }

  // Use rose-wasm for the id calc: its Witness::hash hashes the hax preimage with
  // the STRUCTURAL hash-noun (matching the node's ++hash-noun), so rawTxV1CalcId
  // produces the exact id the node expects.
  const Rose = await getRoseWasm();
  const raw = Rose.nockchainTxToRawTx(signedNockTx);

  const correctedId = Rose.rawTxV1CalcId(raw);
  const rawWithId = { ...raw, id: correctedId } as RawTxV1;
  console.debug("txn id (rose rawTxV1CalcId): ", correctedId);

  const pb = { ...Rose.rawTxToProtobuf(rawWithId), id: correctedId } as PbCom2RawTransaction;

  const txId = pb.id || "unknown-tx-id";

  console.debug('txn id (protobuf): ', txId);
  console.log('pb (raw, may not be fully serializable):', pb);
  console.dir(pb, { depth: 5 });

  await wallet.grpc.sendTransaction(pb);

  console.warn("broadcast txId", txId);

  console.debug(
    "If the node logs 'expected: <someId>' for a liar-effect, you can call " +
    "window.__resendWithCorrectId('<the expected id>') from the console to re-send the same tx bytes with the correct declared id."
  );

  const accepted = await waitTxAccepted(wallet.grpc, txId, 30_000);
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
