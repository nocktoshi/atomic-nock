import { DEFAULT_FEE_PER_WORD } from "../iris.js";
import { getIrisWasm, initIrisWasm, type Lock } from "../iris.js";
import { Digest } from '@nockbox/iris-sdk/wasm'
import {
  htlcLockRootDigest,
  htlcGiftOutputFirstName,
  giftOutputFirstNameFromLockOutputs,
} from "./tx.js";
import { signAndSendIrisTx, type NockWalletSession } from "./wallet.js";
import { fetchWalletNotes, pickLargestNote } from "./balance.js";
import { runStep } from "../grpc.js";

export interface ConsolidateResult {
  txId: string;
  /** Number of input notes merged. */
  noteCount: number;
  /** Total NOCK value (in nicks) swept into the consolidated note (pre-fee). */
  totalNicks: bigint;
}

/**
 * Merge every note in the wallet into a single note via a self-transfer.
 *
 * The HTLC lock spends ONE input note (see {@link lockNock}), so a wallet holding
 * many small notes can't fund a lock even if the total is sufficient. This sweeps
 * all notes back to the seller's own address: a 1-nick output goes to the wallet
 * and the remainder (total − fee) lands in the refund/change note — one note ≥ the
 * total minus the network fee. `signAndSendIrisTx` calls `recalcAndSetFee`, which
 * sizes the fee and balances that refund, so no fee estimate is needed here.
 */
export async function consolidateNotes(
  wallet: NockWalletSession,
  params: { walletAddress: Digest }
): Promise<ConsolidateResult> {
  const sellerPkh = params.walletAddress;

  const { notes, query } = await runStep("Fetch wallet balance", () =>
    fetchWalletNotes(wallet, params.walletAddress)
  );
  if (notes.length < 2) {
    throw new Error(
      `Nothing to consolidate — wallet has ${notes.length} note(s) at ${query}. ` +
        `Consolidation needs at least 2 notes.`
    );
  }
  const totalNicks = notes.reduce((sum, n) => sum + n.assets, 0n);

  return runStep(`Consolidate ${notes.length} notes`, async () => {
    await initIrisWasm();
    const Iris = await getIrisWasm();

    const settings = Iris.txEngineSettingsV1BythosDefault();
    if (BigInt(settings.cost_per_word) !== DEFAULT_FEE_PER_WORD) {
      settings.cost_per_word = String(DEFAULT_FEE_PER_WORD) as typeof settings.cost_per_word;
    }
    const builder = new Iris.TxBuilder(settings);

    // Every input note is p2pkh-locked to this wallet.
    const inputLock = Iris.lockFromList([
      Iris.spendConditionNewPkh(Iris.pkhSingle(sellerPkh as never)),
    ]) as Lock;
    const inputNotes = notes.map((n) => n.note);
    const txLocks = inputNotes.map(() => ({ lock: inputLock, lock_sp_index: 0 }));

    // Self-transfer: recipient and refund are both our own address, so the whole
    // balance stays in-wallet. gift = 1 nick (dust to self); the bulk lands in the
    // refund/change note, which recalcAndSetFee balances to (total − fee).
    builder.simpleSpend(
      inputNotes,
      txLocks as never,
      sellerPkh as never, // recipient
      "1" as never, // gift (dust)
      undefined, // fee_override — recalcAndSetFee computes it
      sellerPkh as never, // refund → the consolidated note
      false
    );

    const txId = await signAndSendIrisTx(wallet, builder, inputNotes);
    return { txId, noteCount: notes.length, totalNicks };
  });
}

export interface LockNockResult {
  txId: string;
  lockFirstName: Digest;
  /** Hash of the seller's input note used for the lock tx. Buyer needs this as the "birth parent" for the HTLC note to pass first-name checks on claim. */
  parentHash?: Digest;
  /** Output index of the gift/HTLC note in the lock tx. */
  birthOutputIndex?: number;
}

export type LockNockPreview = {
  /** HTLC gift output `name.first` — buyer claim address (Iris shows ~gift NOCK here). */
  giftOutputFirstName: Digest;
  /** HTLC OR lock tree root (not a note address; do not use for balance/claim). */
  lockRoot: Digest;
  /** Stale swap JSON had lock root instead of gift output first name. */
  swapLockFirstNameWasLockRoot: boolean;
};

export async function lockNock(
  wallet: NockWalletSession,
  params: {
  /** Seller nockblocks wallet address (base58); must match swap `sellerPkh` after lock. */
  walletAddress: Digest;
  buyerPkh: Digest;
  gift: bigint;
  hNock: Digest;
  refundHeight: bigint;
  /** Pre-lock swap JSON may omit this or wrongly set it to the lock root. */
  swapLockFirstName?: Digest;
  }
): Promise<LockNockResult & { preview: LockNockPreview }> {
  const sellerPkh = params.walletAddress;

  const { notes, query } = await runStep("Fetch wallet balance", () =>
    fetchWalletNotes(wallet, params.walletAddress)
  );

  const { note: inputNote, assets } = await runStep(
    `Select note (${notes.length} from ${query})`,
    async () => pickLargestNote(notes, params.gift)
  );

  const buyerPkh = params.buyerPkh;

  const lockRoot = await htlcLockRootDigest(
    params.hNock,
    buyerPkh,
    sellerPkh,
    params.refundHeight
  );
  const predictedGiftFirst = await htlcGiftOutputFirstName({
    hNock: params.hNock,
    buyerPkh,
    sellerPkh,
    refundHeight: params.refundHeight,
    giftNicks: params.gift,
    inputNote,
  });
  const swapLockFirstNameWasLockRoot =
    params.swapLockFirstName != null &&
    params.swapLockFirstName.trim() !== "" &&
    params.swapLockFirstName === lockRoot;
  if (
    params.swapLockFirstName &&
    !swapLockFirstNameWasLockRoot &&
    params.swapLockFirstName !== predictedGiftFirst
  ) {
    throw new Error(
      `Swap lockFirstName (${params.swapLockFirstName.slice(0, 12)}…) does not match ` +
        `HTLC gift output (${predictedGiftFirst.slice(0, 12)}…). Regenerate swap or re-enter seller address.`
    );
  }

  const preview: LockNockPreview = {
    giftOutputFirstName: predictedGiftFirst,
    lockRoot,
    swapLockFirstNameWasLockRoot,
  };

  return runStep("Build, sign, and send lock tx", async () => {
    await initIrisWasm();
    const Iris = await getIrisWasm();

    const lockRootDigest = lockRoot;

    const parentHash = Iris.noteHash(inputNote);

    const inputLock = Iris.lockFromList([
      Iris.spendConditionNewPkh(Iris.pkhSingle(sellerPkh as never)),
    ]) as Lock;
    const refundLock = inputLock;

    const spend = new Iris.SpendBuilder(inputNote, inputLock, 0, refundLock);

    const htlcSeed = {
      lock_root: lockRootDigest,
      note_data: Iris.noteDataEmpty(),
      gift: String(params.gift),
      parent_hash: parentHash,
    } as never;
    spend.seed(htlcSeed);
    spend.computeRefund(false);
    if (!spend.isBalanced()) {
      throw new Error(
        `Spend not balanced (note has ${Number(assets) / 65536} NOCK, gift ${Number(params.gift) / 65536} NOCK)`
      );
    }

    const settings = Iris.txEngineSettingsV1BythosDefault();
    if (BigInt(settings.cost_per_word) !== DEFAULT_FEE_PER_WORD) {
      settings.cost_per_word = String(DEFAULT_FEE_PER_WORD) as typeof settings.cost_per_word;
    }
    const builder = new Iris.TxBuilder(settings);
    builder.spend(spend);
    builder.recalcAndSetFee(false);

    // Extract lockFirstName using iris raw outputs (prediction matches real)
    const tempTx = builder.build();
    const tempRaw = Iris.nockchainTxToRawTx(tempTx);
    const tempOuts = Iris.rawTxV1Outputs(tempRaw, 0, settings);
    const lockFirstName = giftOutputFirstNameFromLockOutputs(tempOuts, params.gift);
    if (lockFirstName !== predictedGiftFirst) {
      throw new Error(
        `Built HTLC gift output ${lockFirstName.slice(0, 12)}… disagrees with preview ` +
          `${predictedGiftFirst.slice(0, 12)}…`
      );
    }

    const txId = await signAndSendIrisTx(wallet, builder, [inputNote]);
    // parentHash was computed earlier in the step (line ~98) from the inputNote.
    // tempOuts is from the verification temp build in this step.
    // Find the output index of the gift for the birth source the buyer will need.
    let birthOutputIndex = 0;
    for (let i = 0; i < tempOuts.length; i++) {
      if (BigInt(tempOuts[i].assets as string | number | bigint) === params.gift) {
        birthOutputIndex = i;
        break;
      }
    }
    return { txId, lockFirstName, preview, parentHash, birthOutputIndex };
  });
}