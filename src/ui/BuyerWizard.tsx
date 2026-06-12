/** Buyer (USDC → NOCK) wizard — React port of buyer-wizard.ts, with open-swap claim. */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Address, Hex } from "viem";
import type { SwapPublic, DraftSwap } from "../swap.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { SwapRepository } from "../app/repo/swap-repo.js";
import { lockUsdcAction, resolvePreimage } from "../actions/buyer.js";
import { verifyNockLockConfirmed } from "../nock/balance.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { swapStatus } from "../app/roles.js";
import { useSession, type SessionValue } from "./session.js";
import { useLog, LogBox, type LogApi } from "./log.js";
import { Wizard, type WizardStep } from "./Wizard.js";
import { SwapCard } from "./SwapCard.js";
import { nicksToNock, quoteDisplay, short, useResolvedNock } from "./util.js";

/** On-chain state of the seller's NOCK lock, as the buyer verifies it. */
type LockCheck = "waiting" | "verifying" | "confirmed" | "mismatch";

/** Shared context threaded into every buyer step (body + onNext). */
interface BuyerCtx {
  swap: DraftSwap;
  setSwap: Dispatch<SetStateAction<DraftSwap>>;
  nock: NockWalletSession;
  evm: Address;
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
  /** On-chain state of the seller's NOCK lock (gates locking USDC). */
  lockCheck: LockCheck;
}

/** Initial step. An unclaimed open swap (or one claimed by someone else) starts
 *  at the claim step; otherwise jump to the buyer's current progress. */
function stepForSwap(swap: DraftSwap, myPkh: string | undefined): number {
  if (!swap.hEvm) return 0;
  const mine = !!swap.buyerPkh && swap.buyerPkh === myPkh;
  if (!mine) return 0; // must claim (or it's not ours)
  const st = swapStatus(swap as SwapPublic);
  if (st === "claimed" || st === "refunded") return 4;
  if (st === "withdrawn") return 3;
  if (st === "usdc-locked") return 2;
  return 1; // claimed, lock USDC next
}

// --- Step bodies (module-level so inputs never remount) -----------------------

function ClaimSwapBody({ swap, evm, nock }: BuyerCtx) {
  const claimedByOther = !!swap?.buyerPkh && swap.buyerPkh !== nock.pkh;
  const giftNock = swap?.nockGift != null ? nicksToNock(swap.nockGift) : "—";
  const quote = quoteDisplay(swap ?? {});
  const seller = useResolvedNock(swap?.sellerPkh, short(swap?.sellerPkh, 8, 6));
  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Seller</span>
          <span className="v" title={seller.title ?? swap?.sellerPkh}>
            {seller.text}
          </span>
        </div>
        <div className="swap-card-row">
          <span className="k">You receive</span>
          <span className="v">{giftNock} NOCK</span>
        </div>
        <div className="swap-card-row">
          <span className="k">You pay</span>
          <span className="v">{quote.amountLabel}</span>
        </div>
      </div>
      {claimedByOther ? (
        <p className="fee-disclaimer">
          This swap has already been claimed by another wallet.
        </p>
      ) : (
        <p className="hint">
          Claiming commits your wallets to this swap: NOCK is sent to your Iris
          address and you'll lock {quote.symbol} from {short(evm, 6, 4)}. No addresses to type.
        </p>
      )}
    </div>
  );
}

function LockBody({ swap, lockCheck }: BuyerCtx) {
  const quote = quoteDisplay(swap ?? {});
  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">You pay</span>
          <span className="v">{quote.amountLabel}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">You receive</span>
          <span className="v">{swap?.nockGift != null ? `${nicksToNock(swap.nockGift)} NOCK` : "—"}</span>
        </div>
      </div>
      {lockCheck === "confirmed" ? (
        <p className="preimage-status ok">
          ✓ Seller's NOCK lock is confirmed on-chain and locked to your wallet — safe to lock {quote.symbol}.
        </p>
      ) : lockCheck === "mismatch" ? (
        <p className="log error">
          ⚠️ This swap is not safe to lock {quote.symbol} into (wrong NOCK lock, or unsafe
          timelocks — see the message below). Do not proceed; ask the seller to
          re-post, or walk away.
        </p>
      ) : (
        <p className="fee-disclaimer">
          {lockCheck === "verifying"
            ? `Verifying the seller's NOCK lock on-chain… you can lock ${quote.symbol} once it's confirmed.`
            : `Waiting for the seller to lock NOCK on Nockchain. Don't lock ${quote.symbol} until it's confirmed on-chain.`}
        </p>
      )}
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
          ? `Preimage ready (${preimageLen} bytes).`
          : hasWithdraw
            ? "Seller has withdrawn — loading the preimage from Base automatically…"
            : "After the seller withdraws on Base, the preimage loads automatically."}
      </p>
      <label>Seller withdraw tx (optional — only if auto-load fails)</label>
      <input
        pattern="^0x[0-9a-fA-F]{64}$"
        placeholder="0x… from seller after their Base withdraw"
        value={withdrawTx}
        onChange={(e) => setWithdrawTx(e.target.value)}
      />
    </div>
  );
}

function ClaimNockBody({ swap, preimageReady, preimageLen, hasWithdraw }: BuyerCtx) {
  const seller = useResolvedNock(swap?.sellerPkh, short(swap?.sellerPkh, 8, 6));
  const giftNock = swap?.nockGift != null ? nicksToNock(swap.nockGift) : "—";
  return (
    <div>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">From</span>
          <span className="v" title={seller.title ?? swap?.sellerPkh}>
            {swap?.lockFirstName ? seller.text : "—"}
          </span>
        </div>
        <div className="swap-card-row">
          <span className="k">Amount</span>
          <span className="v">{giftNock} NOCK</span>
        </div>
      </div>
      {!swap?.lockFirstName && (
        <p className="hint">Waiting for the seller to lock NOCK on Nockchain.</p>
      )}
      <p className={"preimage-status" + (preimageReady ? " ok" : "")}>
        {preimageReady
          ? `Preimage ready (${preimageLen} bytes).`
          : hasWithdraw
            ? "Loading preimage from Base automatically…"
            : "Preimage will load once the seller withdraws on Base."}
      </p>
    </div>
  );
}

function DoneBody({ swap }: BuyerCtx) {
  const giftNock = swap?.nockGift != null ? nicksToNock(swap.nockGift) : "—";
  return (
    <div>
      <p className="swap-complete-heading">🎉🎉 Swap complete. 🎉🎉</p>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">Amount received</span>
          <span className="v">{giftNock} NOCK</span>
        </div>
        {swap?.nockClaimTxId && (
          <div className="swap-card-row">
            <span className="k">Transaction</span>
            <span className="v">{swap.nockClaimTxId}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const steps: WizardStep<BuyerCtx>[] = [
  {
    id: "claim-swap",
    title: "Claim this swap",
    nextLabel: "Claim swap",
    Body: ClaimSwapBody,
    canAdvance: ({ swap, evm }) => !swap?.buyerPkh && !!evm,
    async onNext({ swap, setSwap, evm, repo, log }) {
      if (!swap?.hEvm) throw new Error("No swap selected");
      if (!evm) throw new Error("Connect MetaMask (Base) to claim — you lock the quote token from it.");
      const committed = await repo.claim(swap.hEvm, evm);
      setSwap(committed);
      log(`Swap claimed — you're committed as the buyer. Now lock ${quoteDisplay(committed).symbol}.`, true);
    },
  },
  {
    id: "lock-usdc",
    title: ({ swap }) => `Lock ${quoteDisplay(swap ?? {}).symbol}`,
    nextLabel: ({ swap }) => `Lock ${quoteDisplay(swap ?? {}).symbol}`,
    Body: LockBody,
    // Only lock USDC once the seller's NOCK lock is confirmed on-chain.
    canAdvance: ({ lockCheck }) => lockCheck === "confirmed",
    async onNext({ swap, setSwap, repo, log, setEvmSwapId, nock }) {
      if (!swap?.lockFirstName || swap.nockGift == null) {
        throw new Error(`Wait for the seller to lock NOCK before locking your ${quoteDisplay(swap).symbol}.`);
      }
      // Re-verify on-chain right before locking — the gate could be stale.
      const { ok, reason } = await verifyNockLockConfirmed(nock, {
        lockFirstName: swap.lockFirstName,
        lockRoot: swap.lockRoot,
        parentHash: swap.parentHash,
        hNock: swap.hNock!,
        buyerPkh: nock.pkh,
        sellerPkh: swap.sellerPkh!,
        refundHeight: swap.nockRefundHeight!,
        gift: swap.nockGift,
        usdcTimelock: swap.usdcTimelock,
        nockRefundHeight: swap.nockRefundHeight,
      });
      if (!ok) {
        throw new Error(`Won't lock ${quoteDisplay(swap).symbol} — ${reason ?? "NOCK lock not verified on-chain"}.`);
      }
      const { swapId, lockTxHash, swap: locked } = await lockUsdcAction({
        swap: swap as SwapPublic,
      });
      setSwap(locked);
      setEvmSwapId(swapId);
      await repo.put(locked);
      log(`${quoteDisplay(swap).symbol} locked.\nswapId: ${swapId}\ntx: ${lockTxHash}`, true);
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
    id: "claim-nock",
    title: "Claim NOCK",
    nextLabel: "Claim NOCK",
    Body: ClaimNockBody,
    // Needs the seller's lock (lockFirstName) and the loaded preimage.
    canAdvance: ({ swap, preimageReady }) => !!swap?.lockFirstName && preimageReady,
    async onNext({ swap, setSwap, repo, log, withdrawTx, ensurePreimage, claimNockAction }) {
      if (!swap) throw new Error("No swap selected");
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
      log(`NOCK claimed (Iris signed).\nTransaction ID: ${txId}`, true);
    },
  },
  {
    id: "done",
    title: "Complete",
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

  const [index, setIndex] = useState(() => stepForSwap(swap, nock?.pkh));
  const [withdrawTx, setWithdrawTx] = useState("");
  const [preimageReady, setPreimageReady] = useState(false);
  const [preimageLen, setPreimageLen] = useState(0);
  const [lockCheck, setLockCheck] = useState<LockCheck>("waiting");

  const preimageRef = useRef<Uint8Array | null>(null);
  const evmSwapIdRef = useRef<Hex | null>(null);
  const autoLoadTried = useRef(false);

  async function ensurePreimage(tx: Hex | ""): Promise<Uint8Array> {
    if (preimageRef.current) return preimageRef.current;
    if (!swap) throw new Error("No swap selected");
    const { preimageJam } = await resolvePreimage({
      swap: swap as SwapPublic,
      cached: preimageRef.current,
      withdrawTx: tx,
      swapId: evmSwapIdRef.current,
    });
    preimageRef.current = preimageJam;
    setPreimageReady(true);
    setPreimageLen(preimageJam.length);
    return preimageJam;
  }

  const stepId = steps[index]?.id;

  // Entry: show wallet status in the log.
  useEffect(() => {
    if (nock && evm) log(`Iris: ${nock.pkh.slice(0, 16)}…\nMetaMask: ${evm}`, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On a direct /swap/:id load the initial step is computed before the wallet has
  // connected (pkh unknown), so an already-claimed buyer wrongly lands on the
  // claim step. Reposition once, when the wallet's pkh first becomes available.
  const positioned = useRef(false);
  useEffect(() => {
    if (positioned.current || !nock?.pkh) return;
    positioned.current = true;
    setIndex(stepForSwap(swap, nock.pkh));
  }, [nock?.pkh, swap]);

  // On the Lock-USDC step, poll the swap for the seller's lock and verify the
  // on-chain HTLC note is locked under this swap's exact conditions before the
  // buyer risks any USDC. Stops once confirmed or a mismatch is detected.
  useEffect(() => {
    if (stepId !== "lock-usdc" || lockCheck === "confirmed" || lockCheck === "mismatch") {
      return;
    }
    if (!nock) return;
    const id = swap?.hEvm;
    if (!id) return;
    let alive = true;
    const tick = async () => {
      try {
        const fresh = await repo.get(id, { maxAgeMs: 5000 });
        if (!alive || !fresh) return;
        if (!fresh.lockFirstName) {
          setLockCheck("waiting");
          return;
        }
        setLockCheck("verifying");
        const { ok, reason, fatal } = await verifyNockLockConfirmed(nock, {
          lockFirstName: fresh.lockFirstName,
          lockRoot: fresh.lockRoot,
          parentHash: fresh.parentHash,
          hNock: fresh.hNock,
          buyerPkh: nock.pkh,
          sellerPkh: fresh.sellerPkh,
          refundHeight: fresh.nockRefundHeight,
          gift: fresh.nockGift,
          usdcTimelock: fresh.usdcTimelock,
          nockRefundHeight: fresh.nockRefundHeight,
        });
        if (!alive) return;
        if (ok) {
          setSwap(fresh);
          setLockCheck("confirmed");
          log(`Seller's NOCK lock confirmed on-chain — safe to lock ${quoteDisplay(swap ?? {}).symbol}.`, true);
        } else if (fatal) {
          // Hard failure (wrong lock, or unsafe timelocks) — stop and warn.
          setLockCheck("mismatch");
          logErr(new Error(`Unsafe to lock ${quoteDisplay(swap ?? {}).symbol} — ${reason}`));
        }
        // else: transient (note not on-chain yet, height unreadable) → keep polling.
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, lockCheck, swap?.hEvm, nock]);

  // Auto-load the preimage once the seller has withdrawn (preimage / claim-nock steps).
  useEffect(() => {
    if (
      (stepId === "load-preimage" || stepId === "claim-nock") &&
      !preimageRef.current &&
      swap?.usdcWithdrawTxHash &&
      !autoLoadTried.current
    ) {
      autoLoadTried.current = true;
      ensurePreimage("")
        .then(() => log("Preimage loaded automatically from Base.", true))
        .catch((e) => logErr(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, swap]);

  // The "done" step shows the completion summary (amount + tx id) in DoneBody;
  // the claim log line (with the broadcast tx id) is left intact, not overwritten.

  // Guard: both wallets must be connected before the form is useful.
  if (!nock || !evm) {
    const missing = [!nock && "Iris (Nockchain)", !evm && "MetaMask (Base)"]
      .filter(Boolean)
      .join(" and ");
    return (
      <>
        <h2 className="flow-title">Buyer ({quoteDisplay(swap ?? {}).symbol} → NOCK)</h2>
        <p className="hint">
          Connect {missing} using the buttons above to participate in a swap.
        </p>
      </>
    );
  }

  const ctx: BuyerCtx = {
    swap,
    setSwap,
    nock,
    evm,
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
    lockCheck,
  };

  return (
    <>
      <h2 className="flow-title">Buyer ({quoteDisplay(swap ?? {}).symbol} → NOCK)</h2>
      <Wizard
        steps={steps}
        index={index}
        ctx={ctx}
        onIndexChange={setIndex}
        onError={logErr}
      />
      <LogBox state={logState} />
      {swap?.hEvm && (
        <SwapCard swap={swap as SwapPublic} json={JSON.stringify({ swapId: swap.hEvm })} />
      )}
    </>
  );
}
