/**
 * Unified solver swap box — flip direction like the marketplace SwapBox. Buy
 * posts a bid (USDC → NOCK); sell posts an open ask (NOCK → USDC). Active
 * in-progress flows resume on /order/:id (buy) or /sell/:id (sell).
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { useSolverRfq } from "./useSolverRfq.js";
import { useWalletConnectActions } from "./useWalletConnectActions.js";
import { subscribeWallets, getWalletsSnapshot } from "../evm/providers.js";
import { TokenIcon } from "./TokenIcon.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { generateSwapAction } from "../actions/seller.js";
import { secretStore } from "../app/storage/secret-store.js";
import {
  DEFAULT_NOCK_REFUND_DELTA,
  MIN_NOCK_AMOUNT,
  SOLVER_ASK_WINDOW_SEC,
} from "../config.js";
import { fetchCurrentBlockHeight } from "../nock/balance.js";
import { belowMinNock, minNockAmountError, NICKS_PER_NOCK } from "./util.js";

type Direction = "buy" | "sell";

export function SolverTrade() {
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock, evm } = useSession();
  const { connectIris, connectEvm, connectBusy } = useWalletConnectActions();
  const evmWallets = useSyncExternalStore(subscribeWallets, getWalletsSnapshot);
  const [evmPickerOpen, setEvmPickerOpen] = useState(false);
  const { state: logState, log, logErr } = useLog(
    "Swap native NOCK with USDC — the solver quotes on demand; you approve each wallet step."
  );

  const [direction, setDirection] = useState<Direction>("buy");
  const [usd, setUsd] = useState("");
  const [nockAmt, setNockAmt] = useState("");
  const [busy, setBusy] = useState(false);

  const rfqAmount = direction === "buy" ? usd : nockAmt;
  const { quote: rfq, loading: rfqLoading, online } = useSolverRfq(direction, rfqAmount);

  const quoteReady = rfq?.status === "ready";
  const estOut =
    quoteReady && rfq.amountOut
      ? direction === "buy"
        ? parseFloat(rfq.amountOut)
        : parseFloat(rfq.amountOut)
      : null;
  const maxIn =
    quoteReady && rfq.maxAmountIn
      ? direction === "buy"
        ? parseFloat(rfq.maxAmountIn)
        : parseFloat(rfq.maxAmountIn)
      : null;
  const amtIn = parseFloat(direction === "buy" ? usd : nockAmt);
  const overMax = maxIn != null && Number.isFinite(amtIn) && amtIn > maxIn;
  const underMin =
    direction === "sell"
      ? belowMinNock(parseFloat(nockAmt))
      : estOut != null && belowMinNock(estOut);

  function flip(): void {
    setEvmPickerOpen(false);
    setDirection((d) => (d === "buy" ? "sell" : "buy"));
  }

  async function onSubmit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!quoteReady || !rfq?.amountOut) {
        throw new Error(
          rfq?.reason ?? "No solver quote right now — wait for a price or try a smaller amount."
        );
      }

      if (direction === "buy") {
        if (!evm) throw new Error("Connect a Base wallet (pays the USDC).");
        if (!nock) throw new Error("Connect Iris (receives the NOCK).");
        const amt = parseFloat(usd);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a USDC amount.");
        if (maxIn != null && amt > maxIn) {
          throw new Error(
            `The solver can only cover ~$${maxIn.toFixed(2)} right now — try a smaller amount.`
          );
        }
        const nockOut = parseFloat(rfq.amountOut);
        if (belowMinNock(nockOut)) throw new Error(minNockAmountError());
        const nicks = BigInt(Math.floor(nockOut * NICKS_PER_NOCK));
        const bid = await repo.createBid({
          token: "USDC",
          quoteAmount: amt.toFixed(6),
          nockGift: nicks,
          creatorEth: evm,
        });
        localStorage.setItem(
          "auto-swap-buy",
          JSON.stringify({ bidId: bid.id, usd: usd.trim() })
        );
        navigate(`/order/${bid.id}`);
        log(
          `Order placed: ${amt} USDC → ~${nockOut.toFixed(2)} NOCK. The solver locks your NOCK on-chain first.`,
          true
        );
      } else {
        if (!nock) throw new Error("Connect Iris (sends the NOCK).");
        if (!evm) throw new Error("Connect a Base wallet (receives the USDC).");
        const amt = parseFloat(nockAmt);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a NOCK amount.");
        if (belowMinNock(amt)) throw new Error(minNockAmountError());
        if (maxIn != null && amt > maxIn) {
          throw new Error(
            `The solver can only pay for ~${maxIn.toFixed(2)} NOCK right now — try a smaller amount.`
          );
        }
        const height = await fetchCurrentBlockHeight(nock);
        if (height == null) throw new Error("Couldn't read the Nockchain height — reconnect Iris.");
        const usdOut = parseFloat(rfq.amountOut);
        const nicks = BigInt(Math.floor(amt * NICKS_PER_NOCK));
        const walletAddress = nock.address ?? nock.pkh;
        const { swap: created, preimageJam } = await generateSwapAction({
          buyerPkh: "",
          walletAddress,
          sellerEth: evm,
          usdcAmount: usdOut.toFixed(6),
          gift: nicks.toString(),
          refundHeight: (height + DEFAULT_NOCK_REFUND_DELTA).toString(),
          token: "USDC",
          usdcTimeoutSec: SOLVER_ASK_WINDOW_SEC,
        });
        await secretStore.putSellerPreimage(created.hEvm, preimageJam);
        await repo.create(created);
        localStorage.setItem(
          "auto-swap-sell",
          JSON.stringify({ hEvm: created.hEvm, nock: nockAmt.trim() })
        );
        navigate(`/sell/${created.hEvm}`);
        log(
          `Order placed: ${amt} NOCK → ~$${usdOut.toFixed(2)} USDC. The solver will claim it shortly.`,
          true
        );
      }
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  const showPrice = quoteReady && !rfqLoading && estOut != null;
  const submitLabel =
    direction === "buy"
      ? busy
        ? "Placing…"
        : showPrice
          ? `Swap → ~${estOut!.toFixed(2)} NOCK`
          : "Buy NOCK"
      : busy
        ? "Placing…"
        : showPrice
          ? `Swap → ~$${estOut!.toFixed(2)} USDC`
          : "Sell NOCK";

  const walletsReady = !!evm && !!nock;
  const connectTarget =
    direction === "buy"
      ? !evm
        ? "evm"
        : !nock
          ? "nock"
          : null
      : !nock
        ? "nock"
        : !evm
          ? "evm"
          : null;
  const connectLabel =
    connectTarget === "evm"
      ? connectBusy
        ? "Connecting…"
        : "Connect Base"
      : connectTarget === "nock"
        ? connectBusy
          ? "Connecting…"
          : "Connect Iris"
        : "Connect wallets";
  const showEvmPicker = evmPickerOpen && connectTarget === "evm";

  async function onConnectWallets(): Promise<void> {
    if (connectBusy || !connectTarget) return;
    if (connectTarget === "nock") {
      await connectIris();
      return;
    }
    if (evmWallets.length > 1) {
      setEvmPickerOpen((o) => !o);
      return;
    }
    await connectEvm(evmWallets[0]?.info.rdns);
  }

  const maxHint =
    direction === "buy"
      ? maxIn != null && <> · max ${maxIn.toFixed(2)} per swap</>
      : maxIn != null && <> · max {maxIn.toFixed(2)} NOCK per swap</>;

  const overMaxHint =
    maxIn != null
      ? direction === "buy"
        ? `The solver can only cover ~$${maxIn.toFixed(2)} right now — try a smaller amount.`
        : `The solver can only pay for ~${maxIn.toFixed(2)} NOCK right now — try a smaller amount.`
      : null;

  return (
    <section className="panel">
      <h2 className="flow-title">Swap Native NOCK</h2>
      <div className={"swap-interface swap-box" + (rfqLoading ? " quoting" : "")}>
        <div className="swap-panel">
          <span className="swap-panel-label">
            {direction === "buy" ? "You pay" : "You sell (From Iris Wallet)"}
          </span>
          <div className="swap-panel-row">
            {direction === "buy" ? (
              <input
                className="swap-amount"
                type="number"
                min="0"
                placeholder="0"
                value={usd}
                onChange={(e) => setUsd(e.target.value)}
              />
            ) : (
              <input
                className="swap-amount"
                type="number"
                min={String(MIN_NOCK_AMOUNT)}
                placeholder="0"
                value={nockAmt}
                onChange={(e) => setNockAmt(e.target.value)}
              />
            )}
            <div className="swap-token static">
              <TokenIcon token={direction === "buy" ? "USDC" : "NOCK"} />
              {direction === "buy" ? "USDC" : "NOCK"}
            </div>
          </div>
        </div>
        <button
          type="button"
          className={"swap-flip" + (rfqLoading ? " quoting" : "")}
          aria-label="Flip direction"
          title="Flip direction"
          onClick={flip}
        >
          ⇅
        </button>
        <div className="swap-panel">
          <span className="swap-panel-label">
            {direction === "buy"
              ? "You receive (delivered to your Iris wallet)"
              : "You receive"}
          </span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              readOnly
              placeholder="0"
              value={
                rfqLoading
                  ? ""
                  : estOut != null
                    ? direction === "buy"
                      ? estOut.toFixed(2)
                      : estOut.toFixed(2)
                    : ""
              }
            />
            <div className="swap-token static">
              <TokenIcon token={direction === "buy" ? "NOCK" : "USDC"} />
              {direction === "buy" ? "NOCK" : "USDC"}
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
            {maxHint}
          </span>
        ) : rfq?.status === "rejected" || rfq?.status === "expired" ? (
          <span className="addr-resolve-hint swap-warn">{rfq.reason ?? "quote unavailable"}</span>
        ) : null}
        {overMax && overMaxHint && (
          <span className="addr-resolve-hint swap-warn">{overMaxHint}</span>
        )}
        {underMin && (
          <span className="addr-resolve-hint swap-warn">{minNockAmountError()}</span>
        )}
        {!walletsReady ? (
          <div className="wallet-picker">
            <button
              type="button"
              className={"swap-submit" + (connectBusy ? " busy" : "")}
              disabled={connectBusy}
              onClick={() => void onConnectWallets()}
            >
              {connectLabel}
            </button>
            {showEvmPicker && (
              <>
                <div className="wallet-backdrop" onClick={() => setEvmPickerOpen(false)} />
                <div className="wallet-menu">
                  {evmWallets.map((w) => (
                    <button
                      key={w.info.rdns}
                      type="button"
                      className="wallet-menu-item"
                      onClick={() => {
                        setEvmPickerOpen(false);
                        void connectEvm(w.info.rdns);
                      }}
                    >
                      <img src={w.info.icon} alt="" width={18} height={18} />
                      {w.info.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={"swap-submit" + (busy ? " busy" : "")}
            disabled={
              busy ||
              rfqLoading ||
              !quoteReady ||
              !(direction === "buy" ? usd : nockAmt) ||
              overMax ||
              underMin
            }
            onClick={() => void onSubmit()}
          >
            {submitLabel}
          </button>
        )}
      </div>
      <p className="fee-disclaimer">
        Trustless: funds stay protected by on-chain refunds the whole time.
      </p>
      <LogBox state={logState} />
    </section>
  );
}