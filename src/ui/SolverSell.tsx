/**
 * Trustless SELL (NOCK → USDC), app-assisted — the mirror of SolverSwap. One tap
 * posts an OPEN ask priced from the solver's live BID; the solver claims it as
 * buyer, the user locks the exact NOCK on-chain, the solver verifies it to depth
 * K and locks the quoted USDC, then the user withdraws that USDC (revealing the
 * preimage) and is paid. The app auto-drives all the WAITING; each wallet
 * SIGNATURE (lock NOCK in Iris, withdraw USDC on Base) is gated behind a button.
 * The received USDC is exactly the quote — the only network cost is a small
 * Nockchain fee on the NOCK lock. URL-addressable (`/sell/:hEvm`) to resume/share.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { SwapPublic } from "../swap.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { ProgressSteps, type ProgressStep } from "./ProgressSteps.js";
import { BlockTimeline } from "./BlockTimeline.js";
import { TxLink } from "./TxLink.js";
import { useSolverRfq } from "./useSolverRfq.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { generateSwapAction, withdrawUsdcAction } from "../actions/seller.js";
import { secretStore } from "../app/storage/secret-store.js";
import { DEFAULT_NOCK_REFUND_DELTA, SOLVER_ASK_WINDOW_SEC } from "../config.js";
import { fetchCurrentBlockHeight } from "../nock/balance.js";
import { belowMinNock, minNockAmountError, NICKS_PER_NOCK, nicksToNock, short } from "./util.js";
import { MIN_NOCK_AMOUNT } from "../config.js";
import { TokenIcon } from "./TokenIcon.js";

const LS_KEY = "auto-swap-sell";
const SWAP_POLL_MS = 12_000;
const HEIGHT_POLL_MS = 15_000;

type Stage =
  | "input"
  | "waiting-claim" // open ask posted, waiting for the solver to claim (become buyer)
  | "ready-to-lock" // solver claimed — show the "Lock NOCK" button
  | "locking" // user clicked — Iris signing + node acceptance
  | "confirming-lock" // NOCK lock submitted — waiting for depth-K confirms + the solver's USDC lock
  | "ready-to-withdraw" // USDC locked by the solver — show the "Withdraw USDC" button
  | "withdrawing" // user clicked — MetaMask in flight (reveals the preimage)
  | "done"
  | "stalled";

interface Saved {
  hEvm: string;
  nock: string;
}

const STEPS: ProgressStep[] = [
  { label: "Order placed", hint: "Matching with the solver — a few seconds." },
  {
    label: "Lock your NOCK",
    hint: "When ready, tap the button — Iris will ask you to sign the on-chain lock.",
  },
  {
    label: "Solver confirms + pays USDC",
    hint: "The solver waits for your NOCK lock to confirm on Nockchain (a few blocks, ~2–5 min) and then locks the quoted USDC for you. The price of a trustless swap: your NOCK is provably escrowed, never just handed over.",
  },
  {
    label: "Withdraw your USDC",
    hint: "Tap to withdraw — your Base wallet signs once and the USDC is yours.",
  },
];

/** Map flow state → active step index (STEPS.length = all done). */
function stepIndex(stage: Stage, swap: SwapPublic | null): number {
  if (stage === "done" || swap?.usdcWithdrawTxHash) return STEPS.length;
  if (stage === "ready-to-withdraw" || stage === "withdrawing" || swap?.usdcLockTxHash) return 3;
  if (swap?.lockFirstName) return 2; // locked NOCK — waiting on the solver's USDC lock
  if (stage === "ready-to-lock" || stage === "locking") return 1;
  return 0; // order placed / waiting for the solver to claim
}

export function SolverSell() {
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock, evm, lockNockAction, refundNockAction } = useSession();
  const { state: logState, log, logErr } = useLog(
    "Sell native NOCK for USDC — the app handles the waiting; you approve each wallet step."
  );

  const [nockAmt, setNockAmt] = useState("");
  const { quote: rfq, loading: rfqLoading, online } = useSolverRfq("sell", nockAmt);
  const [saved, setSaved] = useState<Saved | null>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  });
  const [stage, setStage] = useState<Stage>("input");
  const [swap, setSwap] = useState<SwapPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const stepStartRef = useRef<{ step: number; at: number }>({ step: -1, at: 0 });
  const actionInFlight = useRef(false);
  const [height, setHeight] = useState<number | null>(null);
  const [blockAgeSec, setBlockAgeSec] = useState(0);
  const blockSeenRef = useRef<{ h: number; at: number }>({ h: 0, at: 0 });
  const swapPollInFlight = useRef(false);
  const heightPollInFlight = useRef(false);

  // Deep-link: a /sell/:hEvm URL seeds the flow (resume / share).
  useEffect(() => {
    if (routeId && saved?.hEvm !== routeId) {
      void Promise.resolve().then(() => setSaved({ hEvm: routeId, nock: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const quoteReady = rfq?.status === "ready";
  const estUsd =
    quoteReady && rfq.amountOut ? parseFloat(rfq.amountOut) : null;
  const maxNock =
    quoteReady && rfq.maxAmountIn ? parseFloat(rfq.maxAmountIn) : null;
  const amtNock = parseFloat(nockAmt);
  const overMax =
    maxNock != null && Number.isFinite(amtNock) && amtNock > maxNock;
  const underMin = belowMinNock(amtNock);

  function persist(next: Saved | null): void {
    if (next) localStorage.setItem(LS_KEY, JSON.stringify(next));
    else localStorage.removeItem(LS_KEY);
    setSaved(next);
  }

  // ── Poller: advances the WAITING states + sets the "ready" gates. ──────────
  useEffect(() => {
    if (!saved?.hEvm) return;
    let alive = true;

    const poll = async () => {
      if (swapPollInFlight.current) return;
      if (actionInFlight.current) return; // don't fight an in-flight wallet step
      swapPollInFlight.current = true;
      try {
        // Bypass the repo's long swap cache — the solver's progress lands
        // server-side, so only a fresh read can see it.
        const s = await repo.get(saved.hEvm, { maxAgeMs: 5000 });
        if (!alive || !s) return;
        setSwap(s);

        if (s.usdcWithdrawTxHash) {
          setStage("done");
          return;
        }
        if (s.usdcLockTxHash) {
          setStage((p) => (p === "withdrawing" ? p : "ready-to-withdraw"));
          return;
        }
        if (s.lockFirstName) {
          // NOCK locked — the solver is confirming it (depth K) and will lock USDC.
          setStage((p) => (p === "locking" ? p : "confirming-lock"));
          return;
        }
        if (s.buyerPkh) {
          // Solver committed as buyer — the user can lock NOCK now.
          if (!nock || !evm) return; // wallets needed to sign
          setStage((p) => (p === "locking" ? p : "ready-to-lock"));
          return;
        }
        setStage("waiting-claim");
      } catch {
        /* transient — next poll */
      } finally {
        swapPollInFlight.current = false;
      }
    };

    void poll();
    const t = window.setInterval(() => void poll(), SWAP_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.hEvm, nock, evm]);

  // Per-step elapsed counter (+ block age while a Nockchain block is pending).
  const activeStep = stepIndex(stage, swap);
  // Block timeline only while a Nockchain block is actually pending: after the
  // user's lock is signed+submitted, until the solver's USDC lock appears. NOT
  // during "locking" — Iris hasn't broadcast yet.
  const waitingOnBlock = stage === "confirming-lock";
  useEffect(() => {
    if (!saved && stage !== "done") return;
    if (stepStartRef.current.step !== activeStep) {
      stepStartRef.current = { step: activeStep, at: Date.now() };
      setElapsedSec(0);
    }
    const t = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - stepStartRef.current.at) / 1000));
      if (blockSeenRef.current.at) {
        setBlockAgeSec(Math.floor((Date.now() - blockSeenRef.current.at) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [activeStep, saved, stage]);

  // Poll the Nockchain head while the lock confirms (drives the block timeline +
  // the refund gate).
  useEffect(() => {
    if (!nock || !waitingOnBlock) return;
    let alive = true;
    const tick = async () => {
      if (heightPollInFlight.current) return;
      heightPollInFlight.current = true;
      try {
        const h = await fetchCurrentBlockHeight(nock).catch(() => undefined);
        if (!alive || h == null) return;
        const hn = Number(h);
        setHeight(hn);
        if (blockSeenRef.current.h !== hn) blockSeenRef.current = { h: hn, at: Date.now() };
      } finally {
        heightPollInFlight.current = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), HEIGHT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [nock, waitingOnBlock]);

  async function onSell(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!nock) throw new Error("Connect Iris (sends the NOCK).");
      if (!evm) throw new Error("Connect a Base wallet (receives the USDC).");
      if (!quoteReady || !rfq?.amountOut) {
        throw new Error(
          rfq?.reason ?? "No solver quote right now — wait for a price or try a smaller amount."
        );
      }
      const amt = parseFloat(nockAmt);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a NOCK amount.");
      if (belowMinNock(amt)) throw new Error(minNockAmountError());
      if (maxNock != null && amt > maxNock) {
        throw new Error(
          `The solver can only pay for ~${maxNock.toFixed(2)} NOCK right now — try a smaller amount.`
        );
      }

      const height = await fetchCurrentBlockHeight(nock);
      if (height == null) throw new Error("Couldn't read the Nockchain height — reconnect Iris.");

      const usd = parseFloat(rfq.amountOut);
      const nicks = BigInt(Math.floor(amt * NICKS_PER_NOCK));
      const walletAddress = nock.address ?? nock.pkh;

      const { swap: created, preimageJam } = await generateSwapAction({
        buyerPkh: "", // OPEN ask — the solver commits as buyer
        walletAddress,
        sellerEth: evm,
        usdcAmount: usd.toFixed(6),
        gift: nicks.toString(),
        refundHeight: (height + DEFAULT_NOCK_REFUND_DELTA).toString(),
        token: "USDC",
        // Short window: the solver refuses long-window asks (they're a free
        // option against it) — this matches its acceptance band.
        usdcTimeoutSec: SOLVER_ASK_WINDOW_SEC,
      });
      // Persist the preimage BEFORE posting so the withdraw can always reveal it.
      await secretStore.putSellerPreimage(created.hEvm, preimageJam);
      await repo.create(created);

      setSwap(created);
      persist({ hEvm: created.hEvm, nock: nockAmt.trim() });
      setStage("waiting-claim");
      navigate(`/sell/${created.hEvm}`);
      log(`Order placed: ${amt} NOCK → ~$${usd.toFixed(2)} USDC. The solver will claim it shortly.`, true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  /** User-initiated: lock the NOCK into the HTLC (Iris signature). */
  async function onLockNock(): Promise<void> {
    if (busy || !swap || !nock) return;
    setBusy(true);
    actionInFlight.current = true;
    try {
      setStage("locking");
      log("Sign in Iris to lock your NOCK…", true);
      const walletAddress = nock.address ?? nock.pkh;
      const { swap: locked, result } = await lockNockAction({ swap, walletAddress });
      await repo.put(locked);
      setSwap({ ...locked });
      // Lock accepted — capture the head so the timeline starts clean, then wait
      // for confirmations + the solver's USDC lock (driven by the main poller).
      const h = await fetchCurrentBlockHeight(nock).catch(() => undefined);
      if (h != null) {
        setHeight(Number(h));
        blockSeenRef.current = { h: Number(h), at: Date.now() };
      }
      setStage("confirming-lock");
      log(
        `NOCK locked (tx ${short(result.txId, 8, 4)}). The solver is confirming it, then pays your USDC.`,
        true
      );
    } catch (e) {
      setStage("ready-to-lock");
      logErr(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  /** User-initiated: withdraw the locked USDC (reveals the preimage on Base). */
  async function onWithdraw(): Promise<void> {
    if (busy || !swap) return;
    setBusy(true);
    actionInFlight.current = true;
    try {
      setStage("withdrawing");
      log("Approve the withdrawal in your Base wallet to collect your USDC…", true);
      const { hash, swap: withdrawn } = await withdrawUsdcAction({ swap });
      await repo.put(withdrawn);
      setSwap({ ...withdrawn });
      setStage("done");
      persist(null);
      log(`🎉 ${withdrawn.usdcAmount} USDC withdrawn to your wallet (tx ${short(hash, 8, 4)}).`, true);
    } catch (e) {
      setStage("ready-to-withdraw");
      logErr(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function onRefund(): Promise<void> {
    if (!swap) return;
    try {
      const { swap: refunded } = await refundNockAction({ swap });
      await repo.put(refunded);
      log("NOCK refunded — your lock is reclaimed.", true);
      reset();
    } catch (e) {
      logErr(e);
    }
  }

  function reset(): void {
    persist(null);
    setSwap(null);
    setStage("input");
    setNockAmt("");
    if (routeId) navigate("/");
  }

  // Seller can reclaim the NOCK once the refund height passes with no USDC
  // locked — the on-chain protection if the solver stalls after our lock.
  const refundable =
    !!swap?.lockFirstName &&
    !swap.usdcLockTxHash &&
    !swap.usdcWithdrawTxHash &&
    !swap.nockRefundTxId &&
    height != null &&
    height >= Number(swap.nockRefundHeight);

  // ── Active flow ────────────────────────────────────────────────────────────
  if (saved || stage === "done") {
    return (
      <section className="panel">
        <h2 className="flow-title">Sell NOCK</h2>
        <div className="swap-order-summary">
          <div className="swap-card-row">
            <span className="k">You sell</span>
            <span className="v">
              {swap ? `${nicksToNock(swap.nockGift)} NOCK` : `${saved?.nock ?? "…"} NOCK`}
            </span>
          </div>
          <div className="swap-card-row sub">
            <span className="k">Plus network fee</span>
            <span className="v">small Nockchain fee on the lock</span>
          </div>
          <div className="swap-card-row">
            <span className="k">You receive</span>
            <span className="v">{swap?.usdcAmount ? `${swap.usdcAmount} USDC` : "…"}</span>
          </div>
          {swap?.lockFirstName && (
            <div className="swap-card-row">
              <span className="k">NOCK locked on-chain</span>
              <span className="v mono">
                ✓ <TxLink id={swap.nockLockTxId ?? swap.lockFirstName} />
              </span>
            </div>
          )}
          {swap?.usdcWithdrawTxHash && (
            <div className="swap-card-row">
              <span className="k">USDC withdraw tx</span>
              <span className="v mono">
                ✓ <TxLink id={swap.usdcWithdrawTxHash} />
              </span>
            </div>
          )}
        </div>

        <ProgressSteps
          steps={STEPS}
          active={activeStep}
          stalled={stage === "stalled"}
          elapsedSec={elapsedSec}
          hideElapsed={waitingOnBlock && height != null}
          activeExtra={
            waitingOnBlock && height != null ? (
              <BlockTimeline height={height} ageSec={blockAgeSec} />
            ) : undefined
          }
        />

        {/* The two user-initiated wallet steps — buttons, never auto-popups. */}
        {stage === "ready-to-lock" && (
          <div className="card-actions">
            <button type="button" className={busy ? "busy" : undefined} disabled={busy} onClick={() => void onLockNock()}>
              {busy ? "Opening Iris…" : `Lock ${swap ? nicksToNock(swap.nockGift) : ""} NOCK`}
            </button>
          </div>
        )}
        {stage === "ready-to-withdraw" && (
          <div className="card-actions">
            <button type="button" className={busy ? "busy" : undefined} disabled={busy} onClick={() => void onWithdraw()}>
              {busy ? "Opening wallet…" : `Withdraw ${swap?.usdcAmount} USDC`}
            </button>
          </div>
        )}

        {stage !== "done" && stage !== "ready-to-lock" && stage !== "ready-to-withdraw" && (
          <p className="trustless-note">
            The waits are Nockchain block confirmations. Your NOCK
            stays protected by an on-chain refund the whole time. 🔐
          </p>
        )}

        {(!nock || !evm) && stage !== "done" && (
          <p className="fee-disclaimer">Connect both wallets so the app can continue.</p>
        )}

        <div className="card-actions">
          {refundable && (
            <button type="button" className="refund-btn" onClick={() => void onRefund()}>
              Refund NOCK (solver stalled)
            </button>
          )}
          <button type="button" className="secondary" onClick={reset}>
            {stage === "done" ? "Sell more" : "Abandon (keeps on-chain refunds available)"}
          </button>
        </div>
        <LogBox state={logState} />
      </section>
    );
  }

  // ── Quote entry ────────────────────────────────────────────────────────────
  return (
    <section className="panel">
      <h2 className="flow-title">Sell NOCK</h2>
      <div className={"swap-interface swap-box" + (rfqLoading ? " quoting" : "")}>
        <div className="swap-panel">
          <span className="swap-panel-label">You sell (From Iris Wallet)</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              type="number"
              min={String(MIN_NOCK_AMOUNT)}
              placeholder="0"
              value={nockAmt}
              onChange={(e) => setNockAmt(e.target.value)}
            />
            <div className="swap-token static">
              <TokenIcon token="NOCK" />
              NOCK
            </div>
          </div>
        </div>
        <div className={"swap-flip" + (rfqLoading ? " quoting" : "")} aria-hidden="true">↓</div>
        <div className="swap-panel">
          <span className="swap-panel-label">You receive</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              readOnly
              placeholder="0"
              value={rfqLoading ? "" : estUsd ? estUsd.toFixed(2) : ""}
            />
            <div className="swap-token static">
              <TokenIcon token="USDC" />
              USDC
            </div>
          </div>
        </div>
        {rfqLoading ? (
          <span className="addr-resolve-hint swap-rate quoting">getting quote…</span>
        ) : online === false || rfq?.status === "offline" ? (
          <span className="addr-resolve-hint swap-rate">no solver online — try again shortly</span>
        ) : quoteReady && rfq.pricePerNock != null ? (
          <span className="addr-resolve-hint swap-rate">
            rate ≈ ${rfq.pricePerNock.toFixed(4)}/NOCK
            {maxNock != null && <> · max {maxNock.toFixed(2)} NOCK per swap</>}
          </span>
        ) : rfq?.status === "rejected" || rfq?.status === "expired" ? (
          <span className="addr-resolve-hint swap-warn">{rfq.reason ?? "quote unavailable"}</span>
        ) : null}
        {overMax && (
          <span className="addr-resolve-hint swap-warn">
            The solver can only pay for ~{maxNock!.toFixed(2)} NOCK right now — try a smaller
            amount.
          </span>
        )}
        {underMin && (
          <span className="addr-resolve-hint swap-warn">{minNockAmountError()}</span>
        )}
        <button
          type="button"
          className={"swap-submit" + (busy ? " busy" : "")}
          disabled={
            busy || rfqLoading || !evm || !nock || !quoteReady || !nockAmt || overMax || underMin
          }
          onClick={() => void onSell()}
        >
          {busy ? "Placing…" : estUsd ? `Swap → ~$${estUsd.toFixed(2)} USDC` : "Swap"}
        </button>
        {(!evm || !nock) && (
          <span className="addr-resolve-hint">Connect Iris (sell NOCK) + Base (receive USDC).</span>
        )}
      </div>
      <LogBox state={logState} />
    </section>
  );
}
