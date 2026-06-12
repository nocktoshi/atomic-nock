/**
 * Trustless buy, app-assisted. One tap posts a bid priced from the solver's live
 * quote; the solver fills it and locks the EXACT quoted NOCK on-chain first. The
 * app auto-drives all the WAITING (matching, confirmations, the solver's
 * withdraw) and verifies the lock — but each wallet SIGNATURE is gated behind an
 * explicit button so a popup never appears unexpectedly. Under-delivery is
 * impossible (the NOCK is verifiably locked before any USDC moves), and the swap
 * is URL-addressable (`/order/:bidId`) so it can be shared or resumed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Hex } from "viem";
import type { SwapPublic } from "../swap.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { ProgressSteps, type ProgressStep } from "./ProgressSteps.js";
import { BlockTimeline } from "./BlockTimeline.js";
import { useSolverRfq } from "./useSolverRfq.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { lockUsdcAction, resolvePreimage, refundUsdcAction } from "../actions/buyer.js";
import { verifyNockLockConfirmed, fetchCurrentBlockHeight } from "../nock/balance.js";
import { belowMinNock, minNockAmountError, NICKS_PER_NOCK, nicksToNock, short } from "./util.js";
import { TxLink } from "./TxLink.js";
import { TokenIcon } from "./TokenIcon.js";

const LS_KEY = "auto-swap-buy";
const SWAP_POLL_MS = 12_000;
const HEIGHT_POLL_MS = 15_000;

type Stage =
  | "input"
  | "waiting-fill" // bid posted, waiting for the solver to fill + lock NOCK
  | "verifying" // lockFirstName seen — verifying the on-chain lock (read-only)
  | "ready-to-lock" // verified — show the "Lock USDC" button
  | "locking" // user clicked — MetaMask in flight
  | "waiting-reveal" // USDC locked — waiting for the solver's withdraw
  | "ready-to-claim" // preimage public — show the "Claim NOCK" button
  | "claiming" // user clicked — Iris signing + node acceptance
  | "confirming-claim" // claim accepted — waiting for the next block to land the NOCK
  | "done"
  | "stalled"; // a wallet prompt was rejected or the solver stalled

interface Saved {
  bidId?: string;
  hEvm?: string;
  usd: string;
}

const STEPS: ProgressStep[] = [
  { label: "Order placed", hint: "Matching with the solver — a few seconds." },
  {
    label: "Solver reserves your NOCK on-chain",
    hint: "Locking your exact NOCK and waiting for it to confirm on Nockchain — usually 2–5 min. The price of a trustless swap: your NOCK is provably yours before you pay a cent.",
  },
  {
    label: "Lock your USDC",
    hint: "When ready, tap the button — your Base wallet will ask you to approve + lock.",
  },
  {
    label: "Solver finalizes",
    hint: "Solver collects the USDC, releasing your NOCK — usually under a minute.",
  },
  {
    label: "Claim your NOCK",
    hint: "Tap to claim and sign once in Iris — your NOCK lands at the next Nockchain block (~2–5 min).",
  },
];

/** Map flow state → active step index (STEPS.length = all done). The lock's
 *  confirmation wait stays on step 2 ("reserves your NOCK"). */
function stepIndex(stage: Stage, swap: SwapPublic | null): number {
  if (stage === "done") return STEPS.length;
  if (
    stage === "ready-to-claim" ||
    stage === "claiming" ||
    stage === "confirming-claim" ||
    swap?.usdcWithdrawTxHash
  ) {
    return 4;
  }
  if (swap?.nockClaimTxId) return STEPS.length; // resumed an already-finished swap
  if (swap?.usdcLockTxHash) return 3;
  if (stage === "ready-to-lock" || stage === "locking") return 2;
  return 1; // ordered / solver reserving + confirming NOCK (incl. verify)
}

export function SolverSwap() {
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock, evm, claimNockAction } = useSession();
  const { state: logState, log, logErr } = useLog(
    "Buy native NOCK with USDC — the app handles the waiting; you approve each wallet step."
  );

  const [usd, setUsd] = useState("");
  const { quote: rfq, loading: rfqLoading, online } = useSolverRfq("buy", usd);
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
  const [nowSec, setNowSec] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const stepStartRef = useRef<{ step: number; at: number }>({ step: -1, at: 0 });
  // True while a wallet action is mid-flight; pauses the poller from clobbering stage.
  const actionInFlight = useRef(false);
  // Nockchain head, for the block-based confirmation indicator.
  const [height, setHeight] = useState<number | null>(null);
  const [blockAgeSec, setBlockAgeSec] = useState(0);
  const blockSeenRef = useRef<{ h: number; at: number }>({ h: 0, at: 0 });
  // Height when the claim was accepted — the NOCK lands once a later block mines.
  const claimHeightRef = useRef(0);
  // Actual NOCK received (gift − claim fee) + the fee, known once the claim is
  // built. Ref mirrors it for the height poll's "landed" message.
  const [claimNet, setClaimNet] = useState<{ received: bigint; fee: bigint } | null>(null);
  const claimNetRef = useRef<{ received: bigint; fee: bigint } | null>(null);
  // Mirror of `stage` for the poller (whose effect deps exclude stage).
  const stageRef = useRef<Stage>("input");
  const swapPollInFlight = useRef(false);
  const heightPollInFlight = useRef(false);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // Deep-link: a /order/:id URL seeds the flow (resume / share).
  useEffect(() => {
    if (routeId && saved?.bidId !== routeId && saved?.hEvm !== routeId) {
      void Promise.resolve().then(() => setSaved({ bidId: routeId, usd: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const quoteReady = rfq?.status === "ready";
  const estNock =
    quoteReady && rfq.amountOut ? parseFloat(rfq.amountOut) : null;
  const maxUsd =
    quoteReady && rfq.maxAmountIn ? parseFloat(rfq.maxAmountIn) : null;
  const amtUsd = parseFloat(usd);
  const overMax =
    maxUsd != null && Number.isFinite(amtUsd) && amtUsd > maxUsd;
  const underMin = estNock != null && belowMinNock(estNock);

  function persist(next: Saved | null): void {
    if (next) localStorage.setItem(LS_KEY, JSON.stringify(next));
    else localStorage.removeItem(LS_KEY);
    setSaved(next);
  }

  // ── Poller: advances the WAITING states + sets the "ready" gates. ──────────
  useEffect(() => {
    if (!saved) return;
    let alive = true;

    const poll = async () => {
      if (swapPollInFlight.current) return;
      if (actionInFlight.current) return; // don't fight an in-flight wallet step
      if (stageRef.current === "confirming-claim") return; // local block-confirm owns this
      swapPollInFlight.current = true;
      try {
        setNowSec(Math.floor(Date.now() / 1000));

        let hEvm = saved.hEvm;
        if (!hEvm && saved.bidId) {
          const found = await repo.getBid(saved.bidId);
          if (!alive) return;
          if (found?.filledHEvm) {
            hEvm = found.filledHEvm;
            persist({ ...saved, hEvm });
          } else {
            setStage("waiting-fill");
            return;
          }
        }
        if (!hEvm) return;

        // Bypass the repo's long swap cache — the solver's progress lands
        // server-side, so only a fresh read can see it.
        const s = await repo.get(hEvm, { maxAgeMs: 5000 });
        if (!alive || !s) return;
        setSwap(s);

        if (s.nockClaimTxId) {
          setStage("done");
          return;
        }
        if (s.usdcWithdrawTxHash) {
          setStage((p) => (p === "claiming" ? p : "ready-to-claim"));
          return;
        }
        if (s.usdcLockTxHash) {
          setStage("waiting-reveal");
          return;
        }
        if (s.lockFirstName) {
          if (!nock || !evm) {
            setStage("verifying");
            return;
          }
          const v = await verifyNockLockConfirmed(nock, {
            lockFirstName: s.lockFirstName,
            lockRoot: s.lockRoot,
            parentHash: s.parentHash,
            hNock: s.hNock,
            buyerPkh: nock.pkh,
            sellerPkh: s.sellerPkh,
            refundHeight: s.nockRefundHeight,
            gift: s.nockGift,
            usdcTimelock: s.usdcTimelock,
            nockRefundHeight: s.nockRefundHeight,
          });
          if (!alive) return;
          if (v.ok) setStage((p) => (p === "locking" ? p : "ready-to-lock"));
          else if (v.fatal) {
            setStage("stalled");
            log(`⚠️ Not safe to proceed: ${v.reason}`, true);
          } else setStage("verifying");
          return;
        }
        setStage("waiting-fill");
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
  }, [saved?.bidId, saved?.hEvm, nock, evm]);

  // Per-step elapsed counter (+ block age while waiting on a Nockchain block).
  // Two block waits: the solver's NOCK lock confirming (step 2), and the user's
  // claim landing (step 5).
  const activeStep = stepIndex(stage, swap);
  // Block timeline only while a Nockchain block is actually pending: the solver's
  // lock confirming (step 2), or the claim AFTER Iris signed+submitted it
  // ("confirming-claim"). NOT during "claiming" — Iris hasn't broadcast yet.
  const waitingOnBlock =
    (activeStep === 1 && !!swap?.lockFirstName) || stage === "confirming-claim";
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

  // Poll the Nockchain head while waiting for the lock to confirm.
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
        // Claim confirms once a block mines after the claim was accepted.
        if (
          stageRef.current === "confirming-claim" &&
          claimHeightRef.current > 0 &&
          hn > claimHeightRef.current
        ) {
          setStage("done");
          persist(null);
          const got = claimNetRef.current?.received;
          log(
            got != null
              ? `🎉 ${nicksToNock(got)} NOCK landed in your wallet.`
              : "🎉 NOCK received.",
            true
          );
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nock, waitingOnBlock]);

  async function onSwap(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!evm) throw new Error("Connect a Base wallet (pays the USDC).");
      if (!nock) throw new Error("Connect Iris (receives the NOCK).");
      if (!quoteReady || !rfq?.amountOut) {
        throw new Error(
          rfq?.reason ?? "No solver quote right now — wait for a price or try a smaller amount."
        );
      }
      const amt = parseFloat(usd);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a USDC amount.");
      if (maxUsd != null && amt > maxUsd) {
        throw new Error(
          `The solver can only cover ~$${maxUsd.toFixed(2)} right now — try a smaller amount.`
        );
      }

      const nockAmt = parseFloat(rfq.amountOut);
      if (belowMinNock(nockAmt)) throw new Error(minNockAmountError());
      const nicks = BigInt(Math.floor(nockAmt * NICKS_PER_NOCK));
      const bid = await repo.createBid({
        token: "USDC",
        quoteAmount: amt.toFixed(6),
        nockGift: nicks,
        creatorEth: evm,
      });
      persist({ bidId: bid.id, usd: usd.trim() });
      setStage("waiting-fill");
      navigate(`/order/${bid.id}`);
      log(`Order placed: ${amt} USDC → ~${nockAmt.toFixed(2)} NOCK. The solver locks your NOCK on-chain first.`, true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  /** User-initiated: lock the USDC (MetaMask approve + lock). */
  async function onLockUsdc(): Promise<void> {
    if (busy || !swap) return;
    setBusy(true);
    actionInFlight.current = true;
    try {
      setStage("locking");
      log("Approve + lock your USDC in your Base wallet…", true);
      const { swap: locked } = await lockUsdcAction({ swap });
      await repo.put(locked);
      setSwap({ ...locked });
      setStage("waiting-reveal");
      log("USDC locked. The solver will reveal next — then you'll claim your NOCK.", true);
    } catch (e) {
      setStage("ready-to-lock");
      logErr(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  /** User-initiated: claim the NOCK (Iris signature). */
  async function onClaim(): Promise<void> {
    if (busy || !swap) return;
    setBusy(true);
    actionInFlight.current = true;
    try {
      if (!nock) throw new Error("Connect Iris to receive your NOCK.");
      setStage("claiming");
      log("Sign in Iris to receive your NOCK…", true);
      const { preimageJam } = await resolvePreimage({
        swap,
        cached: null,
        withdrawTx: (swap.usdcWithdrawTxHash ?? "") as Hex,
        swapId: null,
      });
      const { swap: claimed, txId, received, fee } = await claimNockAction({
        swap,
        preimageJam,
        lockFirstName: swap.lockFirstName ?? "",
        gift: swap.nockGift.toString(),
      });
      await repo.put(claimed);
      setSwap({ ...claimed });
      const net = { received, fee };
      claimNetRef.current = net;
      setClaimNet(net);
      // Claim accepted by the node — the NOCK lands at the next block. Show the
      // block timeline until then (handled by the height poll).
      const h = await fetchCurrentBlockHeight(nock).catch(() => undefined);
      claimHeightRef.current = h != null ? Number(h) : blockSeenRef.current.h;
      setStage("confirming-claim");
      log(
        `Claim signed (tx ${short(txId, 8, 4)}). Receiving ${nicksToNock(received)} NOCK ` +
          `(${nicksToNock(fee)} network fee). It lands at the next Nockchain block.`,
        true
      );
    } catch (e) {
      setStage("ready-to-claim");
      logErr(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function onRefund(): Promise<void> {
    if (!swap) return;
    try {
      const { swap: refunded } = await refundUsdcAction({ swap });
      await repo.put(refunded);
      log("USDC refunded.", true);
      reset();
    } catch (e) {
      logErr(e);
    }
  }

  function reset(): void {
    persist(null);
    setSwap(null);
    setStage("input");
    setUsd("");
    setClaimNet(null);
    claimNetRef.current = null;
    if (routeId) navigate("/");
  }

  const refundable =
    swap?.usdcLockTxHash &&
    !swap.usdcWithdrawTxHash &&
    !swap.usdcRefundTxHash &&
    nowSec > 0 &&
    nowSec >= Number(swap.usdcTimelock);

  // ── Active flow ────────────────────────────────────────────────────────────
  if (saved || stage === "done") {
    return (
      <section className="panel">
        <h2 className="flow-title">Buy NOCK</h2>
        <div className="swap-order-summary">
          <div className="swap-card-row">
            <span className="k">You pay</span>
            <span className="v">{swap?.usdcAmount ?? saved?.usd} USDC</span>
          </div>
          <div className="swap-card-row">
            <span className="k">You receive</span>
            <span className="v">
              {claimNet
                ? `${nicksToNock(claimNet.received)} NOCK`
                : swap
                  ? `${nicksToNock(swap.nockGift)} NOCK`
                  : "…"}
            </span>
          </div>
          {claimNet ? (
            <div className="swap-card-row sub">
              <span className="k">Network fee</span>
              <span className="v">{nicksToNock(claimNet.fee)} NOCK</span>
            </div>
          ) : (
            swap && (
              <div className="swap-card-row sub">
                <span className="k">Network fee</span>
                <span className="v">deducted on claim</span>
              </div>
            )
          )}
          {swap?.lockFirstName && (
            <div className="swap-card-row">
              <span className="k">NOCK reserved on-chain</span>
              <span className="v mono">
                ✓ <TxLink id={swap.nockLockTxId ?? swap.lockFirstName} />
              </span>
            </div>
          )}
          {swap?.nockClaimTxId && (
            <div className="swap-card-row">
              <span className="k">NOCK claim tx</span>
              <span className="v mono">
                ✓ <TxLink id={swap.nockClaimTxId} />
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
            <button type="button" className={busy ? "busy" : undefined} disabled={busy} onClick={() => void onLockUsdc()}>
              {busy ? "Opening wallet…" : `Lock ${swap?.usdcAmount} USDC`}
            </button>
          </div>
        )}
        {stage === "ready-to-claim" && (
          <div className="card-actions">
            <button type="button" className={busy ? "busy" : undefined} disabled={busy} onClick={() => void onClaim()}>
              {busy ? "Opening Iris…" : `Claim ${swap ? nicksToNock(swap.nockGift) : ""} NOCK`}
            </button>
          </div>
        )}

        {stage !== "done" && stage !== "ready-to-lock" && stage !== "ready-to-claim" && (
          <p className="trustless-note">
            The waits are Nockchain block confirmations. Your funds
            stay protected by on-chain refunds the whole time. 🔐
          </p>
        )}

        {(!nock || !evm) && stage !== "done" && (
          <p className="fee-disclaimer">Connect both wallets so the app can continue.</p>
        )}

        <div className="card-actions">
          {refundable && (
            <button type="button" className="refund-btn" onClick={() => void onRefund()}>
              Refund USDC (solver stalled)
            </button>
          )}
          <button type="button" className="secondary" onClick={reset}>
            {stage === "done" ? "Buy more" : "Abandon (keeps on-chain refunds available)"}
          </button>
        </div>
        <LogBox state={logState} />
      </section>
    );
  }

  // ── Quote entry ────────────────────────────────────────────────────────────
  return (
    <section className="panel">
      <h2 className="flow-title">Buy NOCK</h2>
      <div className={"swap-interface swap-box" + (rfqLoading ? " quoting" : "")}>
        <div className="swap-panel">
          <span className="swap-panel-label">You pay</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              type="number"
              min="0"
              placeholder="0"
              value={usd}
              onChange={(e) => setUsd(e.target.value)}
            />
            <div className="swap-token static">
              <TokenIcon token="USDC" />
              USDC
            </div>
          </div>
        </div>
        <div className={"swap-flip" + (rfqLoading ? " quoting" : "")} aria-hidden="true">↓</div>
        <div className="swap-panel">
          <span className="swap-panel-label">You receive (delivered to your Iris wallet)</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              readOnly
              placeholder="0"
              value={rfqLoading ? "" : estNock ? estNock.toFixed(2) : ""}
            />
            <div className="swap-token static">
              <TokenIcon token="NOCK" />
              NOCK
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
            {maxUsd != null && <> · max ${maxUsd.toFixed(2)} per swap</>}
          </span>
        ) : rfq?.status === "rejected" ? (
          <span className="addr-resolve-hint swap-warn">{rfq.reason ?? "quote unavailable"}</span>
        ) : null}
        {overMax && (
          <span className="addr-resolve-hint swap-warn">
            The solver can only cover ~${maxUsd!.toFixed(2)} right now — try a smaller amount.
          </span>
        )}
        {underMin && (
          <span className="addr-resolve-hint swap-warn">{minNockAmountError()}</span>
        )}
        <button
          type="button"
          className={"swap-submit" + (busy ? " busy" : "")}
          disabled={
            busy || rfqLoading || !evm || !nock || !quoteReady || !usd || overMax || underMin
          }
          onClick={() => void onSwap()}
        >
          {busy ? "Placing…" : estNock ? `Swap → ~${estNock.toFixed(2)} NOCK` : "Swap"}
        </button>
        {(!evm || !nock) && (
          <span className="addr-resolve-hint">Connect Base (pay USDC) + Iris (receive NOCK).</span>
        )}
      </div>
      <p className="fee-disclaimer">
        Trustless: the solver locks your exact NOCK on-chain first; the app verifies it before any
        USDC moves. You approve two quick wallet steps; refunds are always available if anything stalls.
      </p>
      <LogBox state={logState} />
    </section>
  );
}
