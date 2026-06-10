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
import { DEFAULT_NOCK_REFUND_DELTA } from "../config.js";
import { secretStore } from "../app/storage/secret-store.js";
import { swapStatus } from "../app/roles.js";
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
  lockNockAction: SessionValue["lockNockAction"];
}

function stepForSwap(swap: DraftSwap): number {
  if (!swap.hEvm) return 0;
  const st = swapStatus(swap as SwapPublic);
  if (st === "withdrawn" || st === "claimed" || st === "refunded") return 3;
  if (st === "nock-locked" || st === "usdc-locked") return 2;
  return 1;
}

const patch = (
  setSwap: SellerCtx["setSwap"],
  fields: Partial<SwapPublic>
): void => setSwap((s) => ({ ...s, ...fields }));

// --- Step bodies (module-level so AddressField inputs never remount) ----------

function GenerateBody({ swap, setSwap }: SellerCtx) {
  const giftNock = swap?.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : 0;
  const usdcNum = parseFloat(swap?.usdcAmount ?? "");
  const priceHint =
    giftNock > 0 && usdcNum > 0
      ? `≈ $${(usdcNum / giftNock).toFixed(4)} per NOCK  ·  ${(
          giftNock / usdcNum
        ).toFixed(2)} NOCK per USDC`
      : "";
  return (
    <div>
      <p className="hint">
        Your Nockchain and Base addresses come from your connected wallets — the buyer
        only enters theirs.
      </p>
      <label>NOCK Amount</label>
      <input
        type="number"
        step="1"
        min="50"
        value={nicksToNock(swap?.nockGift)}
        onChange={(e) => patch(setSwap, { nockGift: nockToNicks(e.target.value) })}
      />
      <label>USDC amount (buyer pays)</label>
      <input
        type="number"
        step="0.01"
        min="0.10"
        value={swap?.usdcAmount ?? ""}
        onChange={(e) => patch(setSwap, { usdcAmount: e.target.value })}
      />
      <span className="addr-resolve-hint">{priceHint}</span>
      <AddressField
        label="Buyer Nockchain Address (only this wallet can claim)"
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

function LockBody({ swap }: SellerCtx) {
  const giftNock =
    swap?.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : NaN;
  const usdcNum = parseFloat(swap?.usdcAmount ?? "");
  const pricePerNock =
    Number.isFinite(giftNock) && giftNock > 0 && Number.isFinite(usdcNum) && usdcNum > 0
      ? usdcNum / giftNock
      : null;
  const sellLabel = swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const receiveLabel = Number.isFinite(usdcNum) ? `$${usdcNum.toFixed(2)}` : "—";
  const buyer = useResolvedNock(swap?.buyerPkh, short(swap?.buyerPkh, 8, 6));

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
          <span className="v">{receiveLabel}</span>
        </div>
        {pricePerNock != null && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">${pricePerNock.toFixed(4)} / NOCK</span>
          </div>
        )}
      </div>
      <p className="fee-disclaimer">
        Fee: a 0.5% protocol fee is deducted from the USDC withdrawal.
      </p>
    </div>
  );
}

function WithdrawBody({ swap }: SellerCtx) {
  const lockedLabel =
    swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const lockTx = swap?.nockLockTxId;

  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Locked</span>
          <span className="v">{lockedLabel}</span>
        </div>
        {lockTx && (
          <div className="swap-card-row">
            <span className="k">Transaction</span>
            <span className="v" title={lockTx}>
              {short(lockTx)}
            </span>
          </div>
        )}
      </div>
      <p className="fee-disclaimer">
        {swap?.usdcLockTxHash
          ? `Buyer locked ${swap.usdcAmount ?? "?"} USDC. Withdraw reveals the preimage on Base; the buyer then claim NOCK.`
          : "Waiting for the buyer to lock USDC on Base."}
      </p>
    </div>
  );
}

function DoneBody() {
  return (
    <div>
      <p>Swap complete — USDC withdrawn and preimage revealed on Base.</p>
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
      const usdcAmount = parseFloat(swap?.usdcAmount ?? "");
      if (!Number.isFinite(usdcAmount) || usdcAmount < 0.1) {
        throw new Error("Minimum USDC amount is $0.10.");
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
      });
      setSwap(created.swap);
      await secretStore.putSellerPreimage(created.swap.hEvm, created.preimageJam);
      await repo.put(created.swap);
      log("Swap created. Share the link above with the buyer.", true);
    },
  },
  {
    id: "lock-nock",
    title: "Lock NOCK on Nockchain",
    nextLabel: "Lock NOCK",
    Body: LockBody,
    async onNext({ swap, setSwap, repo, log, lockNockAction, nock }) {
      if (swap?.lockFirstName) {
        log("NOCK already locked for this swap.", true);
        return;
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
    title: "Withdraw USDC",
    nextLabel: "Withdraw USDC",
    Body: WithdrawBody,
    canAdvance: ({ swap }) => !!swap?.usdcLockTxHash,
    async onNext({ swap, setSwap, repo, log }) {
      const { hash, swap: withdrawn } = await withdrawUsdcAction({
        swap: swap as SwapPublic,
      });
      setSwap(withdrawn);
      await repo.put(withdrawn);
      log(`USDC withdrawn — preimage public on Base.\ntx: ${hash}`, true);
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
  const { nock, evm, lockNockAction, fetchCurrentBlockHeight } = useSession();
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
    lockNockAction,
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
