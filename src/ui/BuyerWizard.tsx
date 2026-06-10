/** Buyer (USDC → NOCK) wizard — React port of buyer-wizard.ts. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Hex } from "viem";
import type { SwapPublic, DraftSwap } from "../swap.js";
import type { SwapRepository } from "../app/repo/swap-repo.js";
import { lockUsdcAction, resolvePreimage } from "../actions/buyer.js";
import type { SessionValue } from "./session.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { swapStatus } from "../app/roles.js";
import { useSession } from "./session.js";
import { useLog, LogBox, type LogApi } from "./log.js";
import { Wizard, type WizardStep } from "./Wizard.js";
import { SwapCard } from "./SwapCard.js";
import { SwapWalletBanner, useSwapWalletStatus } from "./SwapWalletGate.js";
import { NICKS_PER_NOCK, nicksToNock, short, useResolvedNock } from "./util.js";

/** Shared context threaded into every buyer step (body + onNext). */
interface BuyerCtx {
  swap: DraftSwap;
  setSwap: Dispatch<SetStateAction<DraftSwap>>;
  repo: SwapRepository;
  log: LogApi["log"];
  withdrawTx: string;
  setWithdrawTx(v: string): void;
  preimageReady: boolean;
  preimageLen: number;
  hasWithdraw: boolean;
  ensurePreimage(tx: Hex | ""): Promise<Uint8Array>;
  setEvmSwapId(id: Hex): void;
  claimNockAction: SessionValue["claimNockAction"];
}

function stepForSwap(swap: DraftSwap): number {
  if (!swap.hEvm) return 0;
  const st = swapStatus(swap as SwapPublic);
  if (st === "claimed" || st === "refunded") return 3;
  if (st === "withdrawn") return 2;
  if (st === "usdc-locked") return 1;
  return 0;
}

// --- Step bodies (module-level so inputs never remount) -----------------------

function LockBody({ swap }: BuyerCtx) {
  const giftNock =
    swap?.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : NaN;
  const usdcNum = parseFloat(swap?.usdcAmount ?? "");
  const pricePerNock =
    Number.isFinite(giftNock) && giftNock > 0 && Number.isFinite(usdcNum) && usdcNum > 0
      ? usdcNum / giftNock
      : null;
  const buyLabel = swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const payLabel = Number.isFinite(usdcNum) ? `$${usdcNum.toFixed(2)}` : "—";

  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Buy</span>
          <span className="v">{buyLabel}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">Pay</span>
          <span className="v">{payLabel}</span>
        </div>
        {pricePerNock != null && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">${pricePerNock.toFixed(4)} / NOCK</span>
          </div>
        )}
        {swap?.sellerEth && (
          <div className="swap-card-row">
            <span className="k">Seller</span>
            <span className="v" title={swap.sellerEth}>
              {swap.sellerEth}
            </span>
          </div>
        )}
      </div>
      <p className="fee-disclaimer">
        Fee: a 0.5% protocol fee is paid by the seller.
      </p>
    </div>
  );
}

function PreimageBody({
  preimageReady,
  preimageLen,
  hasWithdraw,
  withdrawTx,
  setWithdrawTx,
}: BuyerCtx) {
  return (
    <div>
      <p className={"preimage-status" + (preimageReady ? " ok" : "")}>
        {preimageReady
          ? `Preimage revealed: (${preimageLen} bytes).`
          : hasWithdraw
            ? "Seller has withdrawn — loading the preimage from Base automatically…"
            : "After the seller withdraws USDC, the preimage loads from Base automatically."}
      </p>
      <label>Seller withdraw tx (optional — only if auto-load fails)</label>
      <input
        pattern="^0x[0-9a-fA-F]{64}$"
        placeholder="0x… from seller after USDC withdraw"
        value={withdrawTx}
        onChange={(e) => setWithdrawTx(e.target.value)}
      />
    </div>
  );
}

function ClaimBody({ swap, preimageReady, preimageLen, hasWithdraw }: BuyerCtx) {
  const amountLabel =
    swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const seller = swap?.sellerPkh;
  const sellerDisplay = useResolvedNock(seller, seller ? short(seller) : "—");

  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">From</span>
          <span className="v" title={sellerDisplay.title ?? seller}>
            {seller ? sellerDisplay.text : "—"}
          </span>
        </div>
        <div className="swap-card-row">
          <span className="k">Amount</span>
          <span className="v">{amountLabel}</span>
        </div>
      </div>
      {!swap?.lockFirstName && (
        <p className="hint">Waiting for the seller to lock NOCK on Nockchain.</p>
      )}
      <p className={"preimage-status" + (preimageReady ? " ok" : "")}>
        {preimageReady
          ? `Preimage revealed: (${preimageLen} bytes).`
          : hasWithdraw
            ? "Loading preimage from Base automatically…"
            : "Preimage will load once the seller withdraws USDC on Base."}
      </p>
    </div>
  );
}

function DoneBody({ swap }: BuyerCtx) {
  const amountLabel =
    swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—";
  const txId = swap.nockClaimTxId;

  return (
    <div>
      <p className="swap-complete-heading">Good Job!</p>
      <p className="swap-complete-heading">One step closer to NOCKMILIO...</p>
      
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Amount received</span>
          <span className="v">{amountLabel}</span>
        </div>
        {txId && (
          <div className="swap-card-row">
            <span className="k">Transaction</span>
            <span className="v" title={txId}>
              {txId}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const steps: WizardStep<BuyerCtx>[] = [
  {
    id: "lock-usdc",
    title: "Lock USDC",
    nextLabel: "Lock USDC",
    Body: LockBody,
    async onNext({ swap, setSwap, repo, log, setEvmSwapId }) {
      const { swapId, lockTxHash, swap: locked } = await lockUsdcAction({
        swap: swap as SwapPublic,
      });
      setSwap(locked);
      setEvmSwapId(swapId);
      await repo.put(locked);
      log(`USDC locked.\nswapId: ${swapId}\ntx: ${lockTxHash}`, true);
    },
  },
  {
    id: "load-preimage",
    title: "Load preimage from Base",
    nextLabel: "Load preimage",
    Body: PreimageBody,
    async onNext({ withdrawTx, ensurePreimage, log }) {
      const jam = await ensurePreimage(withdrawTx.trim() as Hex | "");
      log(`Preimage verified against hNock.\nLength: ${jam.length} bytes.`, true);
    },
  },
  {
    id: "claim",
    title: "Claim NOCK",
    nextLabel: "Claim NOCK",
    Body: ClaimBody,
    async onNext({ swap, setSwap, repo, log, withdrawTx, ensurePreimage, claimNockAction }) {
      const full = swap as SwapPublic;
      const preimageJam = await ensurePreimage(withdrawTx.trim() as Hex | "");
      const { txId, swap: claimed } = await claimNockAction({
        swap: full,
        preimageJam,
        lockFirstName: full.lockFirstName ?? "",
        gift: full.nockGift.toString(),
      });
      setSwap(claimed);
      await repo.put(claimed);
      log(`Swap complete — NOCK claimed.\nbroadcast txId ${txId}`, true);
    },
  },
  {
    id: "done",
    title: "🎉🎉 Swap complete. 🎉🎉",
    terminal: true,
    Body: DoneBody,
  },
];

export function BuyerWizard({
  swap,
  setSwap,
}: {
  swap: DraftSwap;
  setSwap: Dispatch<SetStateAction<DraftSwap>>;
}) {
  const { nock, evm, claimNockAction } = useSession();
  const repo = useMemo(() => getSwapRepository(), []);
  const { state: logState, log, logErr } = useLog();

  const [index, setIndex] = useState(() => stepForSwap(swap));
  const [withdrawTx, setWithdrawTx] = useState("");
  const [preimageReady, setPreimageReady] = useState(false);
  const [preimageLen, setPreimageLen] = useState(0);

  const preimageRef = useRef<Uint8Array | null>(null);
  const evmSwapIdRef = useRef<Hex | null>(null);
  const autoLoadTried = useRef(false);

  const ensurePreimage = useCallback(async (tx: Hex | ""): Promise<Uint8Array> => {
    if (preimageRef.current) return preimageRef.current;
    if (!swap.hEvm) throw new Error("No swap selected");
    const { preimageJam } = await resolvePreimage({
      swap: swap as SwapPublic,
      cached: preimageRef.current,
      withdrawTx: tx,
      swapId: evmSwapIdRef.current,
    });
    preimageRef.current = preimageJam;
    setPreimageLen(preimageJam.length);
    setPreimageReady(true);
    return preimageJam;
  }, [swap]);

  // Entry: show wallet status in the log.
  useEffect(() => {
    if (nock && evm) log(`Iris: ${nock.pkh.slice(0, 16)}…\nMetaMask: ${evm}`, true);
  }, [nock, evm, log]);

  // Auto-load the preimage once the seller has withdrawn (steps 2 and 3).
  useEffect(() => {
    if (
      (index === 1 || index === 2) &&
      !preimageRef.current &&
      swap?.usdcWithdrawTxHash &&
      !autoLoadTried.current
    ) {
      autoLoadTried.current = true;
      ensurePreimage("")
        .then(() => log("Preimage loaded automatically from Base.", true))
        .catch((e) => logErr(e));
    }
  }, [index, swap, ensurePreimage, log, logErr]);

  const walletStatus = useSwapWalletStatus(swap);

  const ctx: BuyerCtx = {
    swap,
    setSwap,
    repo,
    log,
    withdrawTx,
    setWithdrawTx,
    preimageReady,
    preimageLen,
    hasWithdraw: !!swap?.usdcWithdrawTxHash,
    ensurePreimage,
    setEvmSwapId: (id) => {
      evmSwapIdRef.current = id;
    },
    claimNockAction,
  };

  return (
    <>
      <h2 className="flow-title">Buy $NOCK</h2>
      <SwapWalletBanner status={walletStatus} connectHint="participate in a swap" />
      <Wizard
        steps={steps}
        index={index}
        ctx={ctx}
        onIndexChange={setIndex}
        onError={logErr}
        actionsEnabled={walletStatus.canAct}
      />
      <LogBox state={logState} />
      {swap.hEvm && (
        <SwapCard
          swap={swap as SwapPublic}
          json={JSON.stringify({ swapId: swap.hEvm })}
        />
      )}
    </>
  );
}
