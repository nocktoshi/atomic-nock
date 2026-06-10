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

  const nicks = (nock: bigint) => nock * 65536n;
  const fmt = (n: bigint) => parseFloat((Number(n) / 65536).toFixed(4));

  // Reserve enough to cover the network fee so the spend can balance. The recipient
  // output carries the bulk (a value we set explicitly, so it never depends on the
  // engine's refund math); any reserve not spent on fee comes back as a small change
  // note (NOT lost). recalcAndSetFee (inside signAndSendIrisTx) sets the real fee.
  const feeReserve = nicks(2n + BigInt(notes.length) * 2n);
  const gift = totalNicks - feeReserve;
  if (gift <= 0n) {
    throw new Error(
      `Balance too low to consolidate — ${fmt(totalNicks)} NOCK across ${notes.length} ` +
        `note(s) doesn't cover the network fee.`
    );
  }

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

    // Self-transfer: recipient and refund are both our own address. The recipient
    // gets `gift` (the bulk) → the consolidated note; the refund holds the leftover
    // fee reserve. Both stay in-wallet.
    builder.simpleSpend(
      inputNotes,
      txLocks as never,
      sellerPkh as never, // recipient (consolidated note)
      String(gift) as never, // gift = total − fee reserve
      undefined, // fee_override — recalcAndSetFee computes it
      sellerPkh as never, // refund (leftover reserve)
      false
    );
    builder.recalcAndSetFee(false);

    // SAFETY: never sign a transaction that doesn't conserve value. A valid tx
    // satisfies inputs == outputs + declaredFee, so (inputs − outputs) must equal
    // the fee the tx itself declares. If more than that is missing, value is being
    // burned by a build bug (e.g. only one note's value reaching the outputs) — we
    // refuse BEFORE signing. This is fee-magnitude-independent: any honest fee,
    // however large, passes; only a gap beyond the declared fee fails.
    const checkTx = builder.build();
    const checkRaw = Iris.nockchainTxToRawTx(checkTx);
    const checkOuts = Iris.rawTxV1Outputs(checkRaw, 0, settings);
    const outSum = checkOuts.reduce(
      (s, o) => s + BigInt(o.assets as string | number | bigint),
      0n
    );
    const declaredFee = BigInt(Iris.rawTxTotalFees(checkRaw));
    const gap = totalNicks - outSum; // inputs − outputs; must equal declaredFee
    const burnedBeyondFee = gap - declaredFee;
    const TOLERANCE = 65536n; // 1 NOCK slack for rounding
    if (
      outSum > totalNicks ||
      gap < 0n ||
      burnedBeyondFee > TOLERANCE ||
      burnedBeyondFee < -TOLERANCE
    ) {
      throw new Error(
        `Refusing to consolidate: value not conserved — ${fmt(outSum)} NOCK out + ` +
          `${fmt(declaredFee)} NOCK declared fee ≠ ${fmt(totalNicks)} NOCK in ` +
          `(${fmt(burnedBeyondFee)} NOCK would be burned beyond the fee). Not signing.`
      );
    }

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