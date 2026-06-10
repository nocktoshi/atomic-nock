/** Seller (NOCK → USDC) wizard — React port of seller-wizard.ts. */
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { SwapPublic, DraftSwap } from "../swap.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { SwapRepository } from "../app/repo/swap-repo.js";
import { generateSwapAction, withdrawUsdcAction } from "../actions/seller.js";
import type { SessionValue } from "./session.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { DEFAULT_NOCK_REFUND_DELTA, TOKENS } from "../config.js";
import { secretStore } from "../app/storage/secret-store.js";
import { useSession } from "./session.js";
import { useLog, LogBox, type LogApi } from "./log.js";
import { Wizard, type WizardStep } from "./Wizard.js";
import { AddressField } from "./AddressField.js";
import { SwapShare } from "./SwapCard.js";
import { SwapWalletBanner, useSwapWalletStatus } from "./SwapWalletGate.js";
import {
  copyText,
  swapUrl,
  nicksToNock,
  nockToNicks,
  quoteDisplay,
  NICKS_PER_NOCK,
  short,
  useResolvedNock,
} from "./util.js";

/** Shared context threaded into every seller step (body + onNext). */
interface SellerCtx {
  swap: DraftSwap;
  setSwap: Dispatch<SetStateAction<DraftSwap>>;
  nock: NockWalletSession | null;
  evm: Address | null;
  repo: SwapRepository;
  log: LogApi["log"];
  logErr: LogApi["logErr"];
  lockNockAction: SessionValue["lockNockAction"];
  consolidateNotes: SessionValue["consolidateNotes"];
}

function stepForSwap(swap: DraftSwap): number {
  if (!swap.hEvm) return 0; // brand new → generate
  // Base the step on the SELLER's own actions so they can never skip locking NOCK
  // (e.g. if the buyer locks USDC before the seller has locked, the seller must
  // still land on the lock step — otherwise they'd withdraw with no lockFirstName
  // and the buyer could never claim).
  if (swap.usdcWithdrawTxHash) return 3; // already withdrew USDC → done
  if (swap.lockFirstName) return 2; // locked NOCK → withdraw USDC
  return 1; // created/claimed but NOT locked yet → lock NOCK
}

const patch = (
  setSwap: SellerCtx["setSwap"],
  fields: Partial<SwapPublic>
): void => setSwap((s) => ({ ...s, ...fields }));

// --- Step bodies (module-level so AddressField inputs never remount) ----------

function GenerateBody({ swap, setSwap }: SellerCtx) {
  const giftNock = swap?.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : 0;
  const usdcNum = parseFloat(swap?.usdcAmount ?? "");
  const quote = quoteDisplay(swap);
  const priceHint =
    giftNock > 0 && usdcNum > 0
      ? quote.kind === "usd"
        ? `≈ $${(usdcNum / giftNock).toFixed(4)} per NOCK  ·  ${(
            giftNock / usdcNum
          ).toFixed(2)} NOCK per USDC`
        : `≈ ${(usdcNum / giftNock).toFixed(4)} ${quote.symbol} per NOCK`
      : "";
  const wnockReady = Boolean(TOKENS.WNOCK.htlc);
  return (
    <div>
      <p className="hint">
        Your Nockchain and Base addresses come from your connected wallets — the buyer
        only enters theirs.
      </p>
      <div className="swap-interface">
        <div className="swap-panel">
          <span className="swap-panel-label">You sell</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              type="number"
              min="50"
              placeholder="0"
              value={nicksToNock(swap?.nockGift)}
              onChange={(e) => patch(setSwap, { nockGift: nockToNicks(e.target.value) })}
            />
            <div className="swap-token static" aria-label="NOCK">
              NOCK
            </div>
          </div>
        </div>
        <div className="swap-connector" aria-hidden="true">
          <span>↓</span>
        </div>
        <div className="swap-panel">
          <span className="swap-panel-label">Buyer pays</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              type="number"
              min={quote.kind === "usd" ? "0.10" : "1"}
              placeholder="0"
              value={swap?.usdcAmount ?? ""}
              onChange={(e) => patch(setSwap, { usdcAmount: e.target.value })}
            />
            <select
              className="swap-token"
              value={swap?.token ?? "USDC"}
              onChange={(e) =>
                patch(setSwap, { token: e.target.value as SwapPublic["token"] })
              }
              aria-label="Buyer pays with"
            >
              <option value="USDC">USDC</option>
              <option value="WNOCK" disabled={!wnockReady}>
                {wnockReady ? "wNOCK" : "wNOCK soon"}
              </option>
            </select>
          </div>
        </div>
        {priceHint && <span className="addr-resolve-hint swap-rate">{priceHint}</span>}
      </div>
      <AddressField
        label="Buyer Nockchain Address — leave blank for an open swap (buyer claims via link)"
        kind="nock"
        value={swap?.buyerPkh ?? ""}
        onChange={(a) => patch(setSwap, { buyerPkh: a as Digest })}
      />
      <label>Refund Block Height</label>
      <input
        type="number"
        step="1"
        min="1"
        value={swap?.nockRefundHeight?.toString() ?? ""}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          patch(setSwap, { nockRefundHeight: digits ? BigInt(digits) : undefined });
        }}
      />
    </div>
  );
}

function LockBody({ swap, nock, log, logErr, consolidateNotes }: SellerCtx) {
  const quote = quoteDisplay(swap);
  const sellLabel = swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const buyer = useResolvedNock(swap?.buyerPkh, short(swap?.buyerPkh, 8, 6));

  const [consolidating, setConsolidating] = useState(false);
  async function onConsolidate(): Promise<void> {
    if (consolidating) return;
    const walletAddress = nock?.address ?? nock?.pkh;
    if (!walletAddress) {
      logErr(new Error("Connect Iris (Nockchain wallet) to consolidate notes."));
      return;
    }
    setConsolidating(true);
    try {
      const { txId, noteCount, totalNicks } = await consolidateNotes(walletAddress);
      const totalNock = Number(totalNicks) / NICKS_PER_NOCK;
      log(
        `Consolidated ${noteCount} notes into one (~${totalNock.toFixed(4)} NOCK before fee).\n` +
          `tx: ${txId}\nWait for it to confirm on-chain, then press Lock NOCK.`,
        true
      );
    } catch (e) {
      logErr(e);
    } finally {
      setConsolidating(false);
    }
  }

  return (
    <div>
      <div className="swap-order-summary">
      {swap?.buyerPkh && (
          <div className="swap-card-row">
            <span className="k">Buyer</span>
            <span className="v" title={buyer.title ?? swap.buyerPkh}>
              {buyer.text}
            </span>
          </div>
        )}
        <div className="swap-card-row">
          <span className="k">Amount</span>
          <span className="v">{sellLabel}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">Receive</span>
          <span className="v">{quote.amountLabel}</span>
        </div>
        {quote.priceLabel && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">{quote.priceLabel}</span>
          </div>
        )}
      </div>
      {!swap?.buyerPkh && (
        <p className="fee-disclaimer">
          Waiting for a buyer to claim this swap — share the link. Their address
          fills in automatically once they claim, then you can lock.
        </p>
      )}
      <div className="consolidate-row">
        <button
          type="button"
          className={consolidating ? "busy" : undefined}
          disabled={consolidating || !nock}
          onClick={onConsolidate}
        >
          {consolidating ? "Consolidating…" : "Consolidate notes"}
        </button>
        <span className="addr-resolve-hint">
          The lock spends one note. If you hold several small notes, merge them
          into one first (a self-transfer).
        </span>
      </div>
      <p className="fee-disclaimer">
        Fee: a 0.5% protocol fee is deducted from the {quote.symbol} withdrawal.
      </p>
    </div>
  );
}

function WithdrawBody({ swap }: SellerCtx) {
  const quote = quoteDisplay(swap);
  const withdrawLabel = quote.amountLabel;
  const soldLabel = swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const lockTx = swap?.nockLockTxId;

  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Withdrawing</span>
          <span className="v">{withdrawLabel}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">You sold</span>
          <span className="v">{soldLabel}</span>
        </div>
        {lockTx && (
          <div className="swap-card-row">
            <span className="k">NOCK lock tx</span>
            <span className="v" title={lockTx}>
              {short(lockTx)}
            </span>
          </div>
        )}
      </div>
      <p className="fee-disclaimer">
        {swap?.usdcLockTxHash
          ? `Buyer locked ${swap.usdcAmount ?? "?"} ${quote.symbol}. Time to claim!`
          : `Waiting for the buyer to lock ${quote.symbol} on Base.`}
      </p>
    </div>
  );
}

function DoneBody({ swap }: SellerCtx) {
  const quote = quoteDisplay(swap);
  const amountLabel = swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const buyer = useResolvedNock(swap?.buyerPkh, short(swap?.buyerPkh, 8, 6));

  return (
    <div>
      <p className="swap-complete-heading">🎉🎉 Swap complete. 🎉🎉</p>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Amount</span>
          <span className="v">{amountLabel}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">Received</span>
          <span className="v">{quote.amountLabel}</span>
        </div>
        {quote.priceLabel && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">{quote.priceLabel}</span>
          </div>
        )}
        {swap?.buyerPkh && (
          <div className="swap-card-row">
            <span className="k">Buyer</span>
            <span className="v" title={buyer.title ?? swap.buyerPkh}>
              {buyer.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const steps: WizardStep<SellerCtx>[] = [
  {
    id: "generate",
    title: "Sell $NOCK",
    nextLabel: "Generate Swap",
    Body: GenerateBody,
    async onNext({ swap, setSwap, evm, repo, log, nock }) {
      const nockAmount =
        swap?.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : NaN;
      if (!Number.isFinite(nockAmount) || nockAmount < 50) {
        throw new Error("Minimum NOCK amount is 50 NOCK.");
      }
      const quote = quoteDisplay(swap);
      const quoteAmount = parseFloat(swap?.usdcAmount ?? "");
      const minQuote = quote.kind === "usd" ? 0.1 : 1;
      if (!Number.isFinite(quoteAmount) || quoteAmount < minQuote) {
        throw new Error(
          quote.kind === "usd"
            ? "Minimum USDC amount is $0.10."
            : `Minimum ${quote.symbol} amount is ${minQuote} ${quote.symbol}.`
        );
      }
      if (!evm) throw new Error("Connect MetaMask (Base).");
      if (!nock) throw new Error("Connect Iris (Nockchain wallet).");
      const walletAddress = nock.address ?? nock.pkh;

      const created = await generateSwapAction({
        buyerPkh: swap?.buyerPkh ?? "",
        walletAddress,
        sellerEth: evm,
        usdcAmount: swap.usdcAmount!,
        gift: swap.nockGift!.toString(), // already nicks
        refundHeight: swap.nockRefundHeight?.toString() ?? "",
        token: swap.token,
      });
      setSwap(created.swap);
      await secretStore.putSellerPreimage(created.swap.hEvm, created.preimageJam);
      await repo.create(created.swap);
      log(
        created.swap.buyerPkh
          ? "Swap created. Share the link above with the buyer."
          : "Open swap created. Share the link — the buyer claims it with their wallet.",
        true
      );
    },
  },
  {
    id: "lock-nock",
    title: "Lock NOCK on Nockchain",
    nextLabel: "Lock NOCK",
    Body: LockBody,
    // Can't lock until a buyer has committed (open swaps wait for a claim).
    canAdvance: ({ swap }) => !!swap?.buyerPkh,
    async onNext({ swap, setSwap, repo, log, lockNockAction, nock }) {
      if (swap?.lockFirstName) {
        log("NOCK already locked for this swap.", true);
        return;
      }
      if (!swap?.buyerPkh) {
        throw new Error("Waiting for a buyer to claim this swap before you can lock.");
      }
      if (!nock) throw new Error("Connect Iris (Nockchain wallet).");
      const walletAddress = nock.address ?? nock.pkh;
      const { swap: locked, result } = await lockNockAction({
        swap: swap as SwapPublic,
        walletAddress,
      });
      setSwap(locked);
      await repo.put(locked);
      const giftNock = Math.floor(Number(locked.nockGift) / NICKS_PER_NOCK);
      log(
        `Locked ${giftNock} NOCK.\ntx: ${result.txId}\nlockFirstName: ${result.lockFirstName.slice(
          0,
          12
        )}…`,
        true
      );
    },
  },
  {
    id: "withdraw-usdc",
    title: ({ swap }) => `Withdraw ${quoteDisplay(swap).symbol}`,
    nextLabel: ({ swap }) => `Withdraw ${quoteDisplay(swap).symbol}`,
    Body: WithdrawBody,
    canAdvance: ({ swap }) => !!swap?.usdcLockTxHash,
    async onNext({ swap, setSwap, repo, log }) {
      const quote = quoteDisplay(swap);
      const { hash, swap: withdrawn } = await withdrawUsdcAction({
        swap: swap as SwapPublic,
      });
      setSwap(withdrawn);
      await repo.put(withdrawn);
      log(`${quote.symbol} withdrawn — preimage public on Base.\ntx: ${hash}`, true);
    },
  },
  {
    id: "done",
    title: "Complete",
    terminal: true,
    Body: DoneBody,
  },
];

export function SellerWizard({
  swap,
  setSwap,
}: {
  swap: DraftSwap;
  setSwap: Dispatch<SetStateAction<DraftSwap>>;
}) {
  const { nock, evm, lockNockAction, consolidateNotes, fetchCurrentBlockHeight } =
    useSession();
  const repo = useMemo(() => getSwapRepository(), []);
  const { state: logState, log, logErr } = useLog();
  const [index, setIndex] = useState(() => stepForSwap(swap));
  const [copyLabel, setCopyLabel] = useState("Copy link");

  // Entry: show wallet status in the log.
  useEffect(() => {
    if (nock && evm) log(`Iris: ${nock.pkh.slice(0, 16)}…\nMetaMask: ${evm}`, true);
  }, [nock, evm, log]);

  // Seed seller address + refund height once Iris connects (new swaps only).
  useEffect(() => {
    if (!nock || swap.hEvm) return;

    const walletKey = nock.address ?? nock.pkh;
    if (walletKey) {
      setSwap((s) =>
        s.sellerPkh || s.hEvm ? s : { ...s, sellerPkh: walletKey as Digest }
      );
    }

    fetchCurrentBlockHeight()
      .then((h) => {
        if (h == null) return;
        setSwap((s) =>
          s.nockRefundHeight || s.hEvm
            ? s
            : { ...s, nockRefundHeight: h + DEFAULT_NOCK_REFUND_DELTA }
        );
      })
      .catch(() => {});
  }, [nock, swap.hEvm, setSwap, fetchCurrentBlockHeight]);

  const walletStatus = useSwapWalletStatus(swap);
  const shareLink = swapUrl(swap.hEvm);

  const ctx: SellerCtx = {
    swap,
    setSwap,
    nock,
    evm,
    repo,
    log,
    logErr,
    lockNockAction,
    consolidateNotes,
  };

  async function copyLink() {
    if (shareLink && (await copyText(shareLink))) {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    }
  }

  return (
    <>
      <h2 className="flow-title">Sell $NOCK</h2>
      <SwapWalletBanner status={walletStatus} connectHint="create a swap" />
      <Wizard
        steps={steps}
        index={index}
        ctx={ctx}
        onIndexChange={setIndex}
        onError={logErr}
        actionsEnabled={walletStatus.canAct}
      />
      <LogBox state={logState} />
      <label>Swap Link (share with buyer)</label>
      {swap.hEvm && shareLink && (
        <>
          <div className="share-link-row">
            <input readOnly value={shareLink} />
            <button type="button" onClick={copyLink}>
              {copyLabel}
            </button>
          </div>
          <SwapShare
            swap={swap as SwapPublic}
            json={JSON.stringify({ swapId: swap.hEvm })}
          />
        </>
      )}
    </>
  );
}
