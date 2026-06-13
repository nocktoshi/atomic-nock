import { runStep } from "../grpc.js";
import { Nicks, Digest, Lock, lockFromList, nockchainTxToRawTx, Note, noteFromProtobuf, noteHash, noteToProtobuf, pkhSingle, rawTxTotalFees, rawTxV1Outputs, seedV1NewSinglePkh, SpendBuilder, spendConditionNewPkh, TxBuilder, txEngineSettingsV1BythosDefault } from '@nockchain/rose-ts'
import {
  htlcOrLock,
  htlcLockRootDigest,
} from "./tx.js";
import { signAndSendRoseTx, type NockWalletSession } from "./wallet.js";
import {
  fetchNotesByFirstName,
  pickLargestNote,
} from "./balance.js";

export interface ClaimResult {
  /** Broadcast Nockchain claim tx id. */
  txId: string;
  /** Declared network fee for the claim tx, in nicks (deducted from the gift). */
  fee: bigint;
  /** NOCK the buyer actually receives = gift − fee, in nicks. */
  received: bigint;
}

export async function claimNock(
  wallet: NockWalletSession,
  params: {
    lockFirstName: Digest;
    preimageJam: Uint8Array;
    hNock: Digest;
    sellerPkh: Digest;
    buyerPkh: Digest;
    refundHeight: bigint;
    gift: Nicks;
    lockRoot?: Digest;
    /** Hash of the note the *seller* used as input when they locked (the "birth parent" of the HTLC gift note). Required for the claim spend to satisfy the node's "spend first name does not match parent note first name" check. */
    parentHash?: Digest;
    /** Output index of the HTLC gift note in the seller's lock tx (usually 0). */
    birthOutputIndex?: number;
  }
): Promise<ClaimResult> {
  const lockRoot = await htlcLockRootDigest(
    params.hNock,
    params.buyerPkh,
    params.sellerPkh,
    params.refundHeight
  );
  if (params.lockFirstName === lockRoot) {
    throw new Error(
      "lockFirstName is the HTLC lock tree root, not the gift note the buyer claims. " +
      "Ask the seller to re-share swap JSON after Lock NOCK (it updates lockFirstName to the ~1 NOCK output address)."
    );
  }
  if (params.lockRoot && params.lockRoot !== lockRoot) {
    throw new Error(
      `Swap lockRoot does not match HTLC params (got ${params.lockRoot.slice(0, 12)}…, ` +
      `expected ${lockRoot.slice(0, 12)}…). Re-import swap JSON from seller after they locked NOCK.`
    );
  }

  if (wallet.pkh !== params.buyerPkh) {
    throw new Error(
      `Connected Rose pkh (${wallet.pkh}) does not match swap buyerPkh (${params.buyerPkh}) — ` +
      `only the designated buyer can claim. Make sure you are connected with the correct Rose account.`
    );
  }

  const { notes: lockNotes, height } = await runStep("Fetch HTLC note", () =>
    fetchNotesByFirstName(wallet, params.lockFirstName)
  );
  if (!lockNotes.length) {
    throw new Error(`No note at lock first name — wait for seller lock to confirm.\n Block height: ${height}\n Node behind?`);
  }

  const picked = await runStep(
    "Select HTLC note",
    async () => pickLargestNote(lockNotes, BigInt(params.gift.toString()))
  );
  let htlcNote = picked.note;
  const htlcAssets = picked.assets;

  // Inject the birth source/parent so that when we build the claim spend, the node's
  // "spend first name does not match parent note first name" check can succeed.
  // The htlcNote fetched via public balanceByFirstName may not carry its creation source
  // (the seller's input note hash + output index). The seller must share parentHash + birthOutputIndex
  // (computed in the lock flow) in the updated swap JSON.
  //
  // Dev convenience: you can also set these in the console before Claim:
  //   window.__forceParentHash = "6ASqhtgxt...";
  //   window.__forceBirthOutputIndex = 1;
  const debug = globalThis as typeof globalThis & {
    __forceParentHash?: string;
    __forceBirthOutputIndex?: number;
  };
  const effParent = debug.__forceParentHash || params.parentHash;
  const effIdx = debug.__forceBirthOutputIndex ?? params.birthOutputIndex;

  if (effParent) {
    const idx = (typeof effIdx === 'number' ? effIdx : 0);
    // First normalize the fetched note (the roundtrip ensures it's in canonical form
    // that the builder likes).
    htlcNote = noteFromProtobuf(noteToProtobuf(htlcNote));
    // Now attach the birth source AFTER normalization.
    // IMPORTANT: do this in a non-destructive way. Overwriting .name with a brand new plain object
    // (or adding too many extra props) can make the wasm Note no longer deserialize as a valid
    // "untagged enum Note" when passed to SpendBuilder / the builder, causing
    // "data did not match any variant of untagged enum Note".
    const birthSrc = { Parent: { parent: effParent, index: idx } };
    const n = htlcNote as Note & Record<string, unknown>;
    n.source = birthSrc;
    n.parent_hash = effParent;

    // Augment the existing .name in place (if it's an object) instead of replacing the property.
    // This keeps the top-level Note object in a form the wasm bindings can still turn back into
    // a Rust Note (V1 variant) for SpendBuilder.
    if (n.name && typeof n.name === 'object') {
      Object.assign(n.name, {
        source: birthSrc,
        Parent: birthSrc.Parent,
        parent: effParent,
        parent_hash: effParent,
      });
    }

    console.log('htlcNote after parent/source injection + protobuf roundtrip:', htlcNote);
    console.log('htlcNote.source (birth info for input note):', n.source);
    console.log('htlcNote.name (augmented in place):', n.name);
  } else {
    console.warn('Claim: no parentHash (neither in swap JSON nor window.__forceParentHash). The HTLC input name in the pb will be bare {first,last} and the node will reject with "first name does not match". Set the globals and retry (or resend).');
  }

  if (params.sellerPkh === params.buyerPkh) {
    throw new Error(
      "swap sellerPkh equals buyerPkh — re-import swap JSON from seller after they locked NOCK " +
      "(seller must use their nockblocks wallet address, not buyer Rose pkh)"
    );
  }

  const settings = txEngineSettingsV1BythosDefault();
  const tx = new TxBuilder(settings);

  await runStep("Build HTLC claim spend", async () => {
    // Prefer the real OR lock from the fetched note (which has the correct Pkh + Hax branch as set on chain).
    // Fallback to constructed (which now uses high-level ctors after bump).
    let orLock = (htlcNote as Note & { lock?: Lock }).lock;
    if (!orLock) {
      console.debug('building htlcOrLock')
      orLock = await htlcOrLock(
        params.hNock,
        params.buyerPkh,
        params.sellerPkh,
        params.refundHeight
      );
    }

    console.log('orLock:', orLock);
    console.debug("buyerPkh:", params.buyerPkh);

    // Low-level SpendBuilder for the claim input (the HTLC note under the OR lock, branch 0).
    // The 4th arg is the refundLock (used for computeRefund); we use a simple pkh lock for the buyer.
    const buyerPkhLock = lockFromList([
      spendConditionNewPkh(pkhSingle(params.buyerPkh)),
    ]);

    const spend = SpendBuilder.new(htlcNote, orLock, 0, buyerPkhLock);

    const parentHash = noteHash(htlcNote);
    const outputSeed = seedV1NewSinglePkh(
      params.buyerPkh,               // recipient pkh (the "address" of the output note)
      htlcAssets as Nicks,             // full assets of *this* HTLC note (clean gift, fee paid elsewhere)
      parentHash,                    // parent_hash = hash of the note we are spending (the HTLC note)
      false                          // include_lock_data (false matches the diags that verified against on-chain)
    );

    spend.seed(outputSeed);
    const added = spend.addPreimage(params.preimageJam);
    console.debug(
      added
        ? `addPreimage (iris-keyed): ${added}`
        : "addPreimage did not match (expected for structural-hash HTLCs); injecting witness hax at pb level"
    );

    spend.computeRefund(false);

    // (Optional but recommended) verify — for the HTLC spend this should now be exactly balanced
    // (gift == htlcAssets) before the top-level fee is assigned to the other spend.
    if (!spend.isBalanced()) {
      console.warn("HTLC spend not balanced after seed + computeRefund (before separate fee note)");
    }

    tx.spend(spend);
    tx.recalcAndSetFee(false);
  });

  // Re-check immediately before handing the built tx to the signer.
  // The Rose extension's sign popup / nock_signTx uses whatever account is *currently active*
  // in the extension at the moment of the popup. The check at the top of claimNock can be
  // stale if the user switched accounts in Rose after connect but before/during the claim flow.
  // If the active key cannot satisfy the Pkh in the claim branch we built, the extension will
  // refuse with exactly the error you saw ("The note is not fully unlocked. ... Pkh { sig_of: ... }").
  const connectedNow = wallet.pkh;
  if (connectedNow !== params.buyerPkh) {
    throw new Error(
      `Connected Rose pkh (${connectedNow}) does not match the buyerPkh required by the ` +
      `claim branch in the tx we just built (${params.buyerPkh}).\n` +
      `In the Rose extension, make sure the account whose pkh is exactly ${params.buyerPkh} ` +
      `is the selected/active one, then retry Claim NOCK.`
    );
  }
  console.debug("claim branch Pkh requirement matches current session pkh; extension should be able to provide the sig (hax preimage already embedded).");

  // Read the claim's declared network fee + the net the buyer actually receives
  // (gift − fee), so the UI stops overstating the amount. Best-effort and
  // non-invasive — mirrors the value-conservation read in lock.ts and never
  // touches the signing path below (which must stay byte-for-byte identical).
  let fee = 0n;
  let received = BigInt(params.gift.toString());
  try {
    const builtForRead = tx.build();
    const raw = nockchainTxToRawTx(builtForRead);
    fee = BigInt(rawTxTotalFees(raw));
    const outs = rawTxV1Outputs(raw, 0, settings);
    received = outs.reduce((s, o) => s + BigInt(o.assets as string | number | bigint), 0n);
  } catch (e) {
    console.warn("claim fee/received read failed (non-fatal):", e);
  }

  const inputNotesForTx = [htlcNote].filter(Boolean) as Note[];
  const txId = await signAndSendRoseTx(wallet, tx, inputNotesForTx);
  return { txId, fee, received };
}

