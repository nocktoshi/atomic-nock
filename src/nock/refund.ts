import { getIrisWasm, initIrisWasm, type Note } from "../iris.js";
import { getRoseWasm, initRoseWasm } from "../rose.js";
import { runStep } from "../grpc.js";
import { Nicks, Digest, Lock } from "@nockbox/iris-sdk/wasm";
import { htlcOrLock } from "./tx.js";
import type { NockWalletSession } from "./wallet.js";
import { signAndSendIrisTx } from "./wallet.js";
import { fetchNotesByFirstName, pickLargestNote } from "./balance.js";
import type { SwapPublic } from "../swap.js";

/**
 * Seller reclaims the locked NOCK via the HTLC's REFUND branch (index 1 in the OR
 * lock built by htlcOrLock: [Pkh(seller), Tim(abs.min = refundHeight)]). No
 * preimage — the node enforces the absolute timelock instead. Mirrors claim.ts.
 *
 * NOTE: like the claim path, the exact note-injection / timelock handling may need
 * on-chain iteration; this is the structural implementation.
 */
export async function refundNock(params: {
  wallet: NockWalletSession;
  swap: SwapPublic;
}): Promise<string> {
  const { wallet, swap } = params;
  if (!swap.lockFirstName) throw new Error("Swap has no lockFirstName to refund");

  await initIrisWasm();
  const Iris = await getIrisWasm();
  await initRoseWasm();
  const Rose = await getRoseWasm();

  if (wallet.pkh !== swap.sellerPkh) {
    throw new Error(
      `Connected Iris pkh (${wallet.pkh}) does not match swap sellerPkh (${swap.sellerPkh}) — ` +
        `only the seller can refund.`
    );
  }

  const { notes: lockNotes, height } = await runStep("Fetch HTLC note", () =>
    fetchNotesByFirstName(wallet, swap.lockFirstName!)
  );
  if (!lockNotes.length) {
    throw new Error(
      `No note at lock first name — already claimed/refunded, or node behind. Height: ${height}`
    );
  }
  if (height != null && Number(height) < Number(swap.nockRefundHeight)) {
    throw new Error(
      `Refund height not reached yet (current ${height}, refund at ${swap.nockRefundHeight}).`
    );
  }

  let { note: htlcNote, assets: htlcAssets } = await runStep(
    "Select HTLC note",
    async () => pickLargestNote(lockNotes, BigInt(swap.nockGift.toString()))
  );

  // Same birth-source injection as the claim path (needed for the node's
  // "first name matches parent" check).
  const effParent = swap.parentHash;
  const effIdx = typeof swap.birthOutputIndex === "number" ? swap.birthOutputIndex : 0;
  if (effParent) {
    htlcNote = Iris.noteFromProtobuf(Iris.noteToProtobuf(htlcNote));
    const birthSrc = { Parent: { parent: effParent, index: effIdx } };
    const n = htlcNote as any;
    n.source = birthSrc;
    n.parent_hash = effParent;
    if (n.name && typeof n.name === "object") {
      Object.assign(n.name, {
        source: birthSrc,
        Parent: birthSrc.Parent,
        parent: effParent,
        parent_hash: effParent,
      });
    }
  }

  const settings = Iris.txEngineSettingsV1BythosDefault();
  const tx = new Rose.TxBuilder(settings);

  await runStep("Build HTLC refund spend", async () => {
    let orLock = (htlcNote as any).lock as Lock;
    if (!orLock) {
      orLock = await htlcOrLock(
        swap.hNock,
        swap.buyerPkh,
        swap.sellerPkh,
        swap.nockRefundHeight
      );
    }

    const sellerPkhLock = Iris.lockFromList([
      Iris.spendConditionNewPkh(Iris.pkhSingle(swap.sellerPkh)),
    ]);

    // Branch index 1 = the refund (seller + timelock) branch of the OR lock.
    const spend = new Rose.SpendBuilder(htlcNote, orLock, 1, sellerPkhLock);

    const parentHash = Iris.noteHash(htlcNote);
    const outputSeed = Iris.seedV1NewSinglePkh(
      swap.sellerPkh, // refund back to the seller
      htlcAssets as Nicks,
      parentHash,
      false
    );
    spend.seed(outputSeed);
    spend.computeRefund(false);
    if (!spend.isBalanced()) {
      console.warn("HTLC refund spend not balanced after seed + computeRefund");
    }
    tx.spend(spend);
    tx.recalcAndSetFee(false);
  });

  const inputNotesForTx = [htlcNote].filter(Boolean) as Note[];
  return signAndSendIrisTx(wallet, tx, inputNotesForTx);
}
