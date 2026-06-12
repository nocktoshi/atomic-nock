/**
 * Buy native NOCK from ANY supported asset/chain. Two hops, fully self-custodial
 * between them: (1) 1Click swaps your asset → USDC on Base, delivered to YOUR
 * wallet; (2) the app auto-posts a bid (buy NOCK with that USDC) the solver
 * fills. You never give up custody to us — only to 1Click during transit, and to
 * the trustless HTLC during the swap.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { requestSolverRfq, useSolverRfq } from "./useSolverRfq.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { copyText, NICKS_PER_NOCK } from "./util.js";
import {
  listOneClickAssets,
  assetLabel,
  toAtomicUnits,
  type OneClickAsset,
} from "../oneclick/assets.js";
import {
  getOneClickQuote,
  getOneClickStatus,
  isTerminal,
  BASE_USDC_ASSET_ID,
  type OneClickQuote,
  type OneClickStatus,
} from "../oneclick/client.js";

const LS_KEY = "oneclick-buy-flow";

interface PersistedFlow {
  asset: OneClickAsset;
  amount: string;
  quote: OneClickQuote;
  createdAt: number;
}

function loadFlow(): PersistedFlow | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedFlow) : null;
  } catch {
    return null;
  }
}

export function BuyFromAnyChain() {
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { evm } = useSession();
  const { state: logState, log, logErr } = useLog(
    "Swap any asset into native NOCK — pay on any chain, receive NOCK."
  );

  const [assets, setAssets] = useState<OneClickAsset[]>([]);
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<PersistedFlow | null>(() => loadFlow());
  const usdcForRfq = flow?.quote.amountOutFormatted ?? "";
  const { quote: rfq, online } = useSolverRfq("buy", usdcForRfq);
  const [status, setStatus] = useState<OneClickStatus | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy address");

  // EVM-origin assets only for now (the connected MetaMask address serves as both
  // the Base recipient and the origin-chain refund address). Exclude Base USDC
  // (it's the destination). Non-EVM origins need a separate refund address — later.
  useEffect(() => {
    void listOneClickAssets()
      .then((all) => {
        // EVM-origin chains only: the connected MetaMask address is valid as both
        // the Base recipient and the origin-chain refund address. (1Click chain
        // ids — note "bsc", "gnosis", "bera", etc.)
        const evmChains = new Set([
          "eth", "base", "arb", "op", "pol", "avax", "bsc", "gnosis", "bera",
          "scroll", "xlayer", "monad", "abs", "plasma",
        ]);
        const usable = all
          .filter((a) => evmChains.has(a.blockchain) && a.assetId !== BASE_USDC_ASSET_ID)
          .sort((a, b) => assetLabel(a).localeCompare(assetLabel(b)));
        setAssets(usable);
      })
      .catch(logErr);
  }, [logErr]);

  const asset = assets.find((a) => a.assetId === assetId);

  /** On 1Click SUCCESS: auto-post a bid the solver will fill, then go to it. */
  async function onHopComplete(f: PersistedFlow, usdcFormatted: string | null): Promise<void> {
    if (!evm) {
      log("USDC received on Base. Connect a wallet to buy NOCK.", true);
      return;
    }
    try {
      const usdcStr = usdcFormatted ?? f.quote.amountOutFormatted;
      const rfqResult = await requestSolverRfq("buy", usdcStr);
      if (rfqResult.status !== "ready" || !rfqResult.amountOut) {
        log(
          `USDC received on Base (${usdcStr} USDC). Solver quote unavailable — try Buy NOCK manually.`,
          true
        );
        return;
      }
      const nock = parseFloat(rfqResult.amountOut);
      const nicks = BigInt(Math.floor(nock * NICKS_PER_NOCK));
      const usdc = parseFloat(usdcStr);
      const created = await repo.createBid({
        token: "USDC",
        quoteAmount: usdc.toFixed(6),
        nockGift: nicks,
        creatorEth: evm,
      });
      localStorage.removeItem(LS_KEY);
      log(`USDC received — buy order posted for ~${nock.toFixed(2)} NOCK.`, true);
      navigate(`/bid/${created.id}`);
    } catch (e) {
      logErr(e);
    }
  }

  // Poll the 1Click hop once a deposit flow exists.
  useEffect(() => {
    if (!flow) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await getOneClickStatus(flow.quote.depositAddress);
        if (!alive) return;
        setStatus(r.status);
        if (r.status === "SUCCESS") void onHopComplete(flow, r.swapDetails?.amountOutFormatted ?? null);
        else if (isTerminal(r.status)) log(`1Click hop ended: ${r.status}.`, true);
      } catch {
        /* keep polling */
      }
    };
    void poll();
    const t = window.setInterval(poll, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const estNock =
    rfq?.status === "ready" && rfq.amountOut ? parseFloat(rfq.amountOut) : null;

  async function getQuote(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!evm) throw new Error("Connect a Base wallet — your USDC and NOCK land there.");
      if (!asset) throw new Error("Pick an asset to pay with.");
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount.");
      const q = await getOneClickQuote({
        swapType: "EXACT_INPUT",
        originAsset: asset.assetId,
        destinationAsset: BASE_USDC_ASSET_ID,
        amount: toAtomicUnits(amount, asset.decimals),
        recipient: evm, // USDC → your Base wallet
        refundTo: evm, // same EVM address on the origin chain
      });
      const f: PersistedFlow = { asset, amount, quote: q, createdAt: Date.now() };
      localStorage.setItem(LS_KEY, JSON.stringify(f));
      setFlow(f);
      setStatus("PENDING_DEPOSIT");
      log(
        `Quote: ${amount} ${asset.symbol} → ~${q.amountOutFormatted} USDC on Base. ` +
          `Send ${asset.symbol} to the deposit address to begin.`,
        true
      );
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  function cancelFlow(): void {
    localStorage.removeItem(LS_KEY);
    setFlow(null);
    setStatus(null);
  }

  async function copyAddr(): Promise<void> {
    if (flow && (await copyText(flow.quote.depositAddress))) {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy address"), 1500);
    }
  }

  // --- Deposit screen (a flow is in progress) -------------------------------
  if (flow) {
    return (
      <section className="panel">
        <h2 className="flow-title">Buy NOCK — send {flow.asset.symbol}</h2>
        <div className="swap-order-summary">
          <div className="swap-card-row">
            <span className="k">You send</span>
            <span className="v">{flow.amount} {flow.asset.symbol} · {flow.asset.blockchain}</span>
          </div>
          <div className="swap-card-row">
            <span className="k">You'll receive</span>
            <span className="v">~{flow.quote.amountOutFormatted} USDC → ~{estNock?.toFixed(2) ?? "…"} NOCK</span>
          </div>
          <div className="swap-card-row">
            <span className="k">Status</span>
            <span className="v">{status ?? "…"}</span>
          </div>
        </div>
        <label>Send exactly {flow.amount} {flow.asset.symbol} on {flow.asset.blockchain} to:</label>
        <div className="share-link-row">
          <input readOnly value={flow.quote.depositAddress} />
          <button type="button" onClick={() => void copyAddr()}>{copyLabel}</button>
        </div>
        {status === "REFUNDED" || status === "FAILED" ? (
          <p className="log error">
            The 1Click hop {status === "REFUNDED" ? "refunded your deposit" : "failed"}. No NOCK was bought.
          </p>
        ) : (
          <p className="fee-disclaimer">
            Waiting for your deposit. Once 1Click delivers USDC to your Base wallet, a buy
            order is posted automatically and this page moves to the swap. Safe to close —
            reopen this page to resume.
          </p>
        )}
        <div className="card-actions">
          <button type="button" className="secondary" onClick={cancelFlow}>
            {isTerminal(status ?? "PENDING_DEPOSIT") ? "Done" : "Cancel / start over"}
          </button>
        </div>
        <LogBox state={logState} />
      </section>
    );
  }

  // --- Quote entry ----------------------------------------------------------
  return (
    <section className="panel">
      <h2 className="flow-title">Buy NOCK from any chain</h2>
      <div className="swap-interface swap-box">
        <div className="swap-panel">
          <span className="swap-panel-label">You pay</span>
          <div className="swap-panel-row">
            <input
              className="swap-amount"
              type="number"
              min="0"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select
              className="swap-token"
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              aria-label="Pay with"
            >
              <option value="">Select asset…</option>
              {assets.map((a) => (
                <option key={a.assetId} value={a.assetId}>{assetLabel(a)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="swap-flip" aria-hidden="true">↓</div>
        <div className="swap-panel">
          <span className="swap-panel-label">You receive</span>
          <div className="swap-panel-row">
            <input className="swap-amount" readOnly placeholder="NOCK" value="" />
            <div className="swap-token static">NOCK</div>
          </div>
        </div>
        {online === false ? (
          <span className="addr-resolve-hint swap-rate">no solver online — orders may not fill</span>
        ) : (
          <span className="addr-resolve-hint swap-rate">
            native NOCK leg priced on demand when your USDC lands
          </span>
        )}
        <button
          type="button"
          className={"swap-submit" + (busy ? " busy" : "")}
          disabled={busy || !evm || !assetId || !amount}
          onClick={() => void getQuote()}
        >
          {busy ? "Quoting…" : "Get quote"}
        </button>
        {!evm && <span className="addr-resolve-hint">Connect a Base wallet to receive your NOCK.</span>}
      </div>
      <LogBox state={logState} />
    </section>
  );
}
