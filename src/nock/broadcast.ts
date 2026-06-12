/**
 * Signer-independent halves of the Nockchain tx pipeline. The browser flow is
 *   prepareBuiltTx → Iris extension nock_signTx → finalizeAndBroadcast
 * and the solver daemon's is
 *   prepareBuiltTx → TxBuilder.fromNockchainTx(tx).sign(PrivateKey) → finalizeAndBroadcast
 * Extracted verbatim from signAndSendIrisTx (wallet.ts) — the browser flow is
 * the behavioral oracle; do not change semantics here without parity-testing.
 */
import { formatGrpcError } from "../grpc.js";
import type { getIrisWasm, NockchainTx, Note } from "../iris.js";
import { getRoseWasm } from "../rose.js";
import type { PbCom2RawTransaction, RawTxV1 } from "@nockchain/rose-wasm";

type MutableRecord = Record<string, unknown>;

function asMutable(value: unknown): MutableRecord {
  return value as unknown as MutableRecord;
}

type IrisTxBuilder = InstanceType<Awaited<ReturnType<typeof getIrisWasm>>["TxBuilder"]>;

/** The two gRPC calls the broadcast path needs (structural, so any client fits). */
export interface GrpcLike {
  sendTransaction(tx: PbCom2RawTransaction): Promise<unknown>;
  transactionAccepted(txId: string): Promise<boolean>;
}

/** Ensure that any hax preimages present in a built NockchainTx's witness_data are also
 * present directly in the per-spend witness.hax_map. The high-level TxBuilder + addPreimage
 * (via simpleSpend path) currently lands the data in witness_data; the wire form and the
 * Rust-side spend witness expect it on the individual spend so it serializes into the hax
 * list with value bytes for check:hax.
 */
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

export async function waitTxAccepted(
  grpc: GrpcLike,
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

/**
 * Build the tx and apply the pre-sign patches every signer needs: the birth
 * source/Parent forced onto each spend's input name (required for HTLC notes
 * created under an OR lock) and hax preimages synced onto the spend witnesses.
 */
export function prepareBuiltTx(
  builder: IrisTxBuilder,
  inputNotes: Note[] = []
): NockchainTx {
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

  return nockTx;
}

/**
 * Post-sign half: re-sync hax witnesses, compute the canonical id with
 * rose-wasm (structural Witness::hash — matches the node), convert to
 * protobuf, broadcast, and wait for acceptance.
 */
export async function finalizeAndBroadcast(
  grpc: GrpcLike,
  signedNockTx: NockchainTx
): Promise<string> {
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

  await grpc.sendTransaction(pb);

  console.warn("broadcast txId", txId);

  console.debug(
    "If the node logs 'expected: <someId>' for a liar-effect, you can call " +
    "window.__resendWithCorrectId('<the expected id>') from the console to re-send the same tx bytes with the correct declared id."
  );

  const accepted = await waitTxAccepted(grpc, txId, 30_000);
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
