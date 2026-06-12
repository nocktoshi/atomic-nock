/**
 * Uniswap-style order entry: pick what you pay and what you receive — one side
 * is always native NOCK (the protocol's invariant). Selling NOCK posts an open
 * ask (the existing open swap); paying USDC/wNOCK for NOCK posts a bid (a buy
 * order someone fills). Fills are coordinated manually through the wizards,
 * but order ENTRY feels like a swap.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TokenKey } from "../config.js";
import { DEFAULT_NOCK_REFUND_DELTA, TOKENS } from "../config.js";
import { generateSwapAction } from "../actions/seller.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { secretStore } from "../app/storage/secret-store.js";
import { createPriceProvider } from "../market/price.js";
import { useSession } from "./session.js";
import type { LogApi } from "./log.js";
import { TokenIcon, type IconToken } from "./TokenIcon.js";
import { belowMinNock, minNockAmountError, nockToNicks } from "./util.js";
import { MIN_NOCK_AMOUNT } from "../config.js";

const price = createPriceProvider();

const ALL_TOKENS: IconToken[] = ["NOCK", "USDC", "WNOCK"];

function tokenLabel(t: IconToken): string {
  return t === "WNOCK" ? "wNOCK" : t;
}

function minQuote(token: TokenKey): number {
  return token === "USDC" ? 0.1 : 1;
}

/** Icon + ticker dropdown (CoW-style). All three assets are always listed. */
function TokenSelect({
  value,
  onSelect,
  wnockReady,
  ariaLabel,
}: {
  value: IconToken;
  onSelect(t: IconToken): void;
  wnockReady: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="token-select">
      <button
        type="button"
        className="swap-token token-btn"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <TokenIcon token={value} />
        {tokenLabel(value)}
        <span className="token-chevron">▾</span>
      </button>
      {open && (
        <>
          <div className="wallet-backdrop" onClick={() => setOpen(false)} />
          <div className="token-menu">
            {ALL_TOKENS.map((t) => (
              <button
                key={t}
                type="button"
                className={"token-menu-item" + (t === value ? " selected" : "")}
                disabled={t === "WNOCK" && !wnockReady}
                onClick={() => {
                  setOpen(false);
                  if (t !== value) onSelect(t);
                }}
              >
                <TokenIcon token={t} />
                {t === "WNOCK" && !wnockReady ? "wNOCK (soon)" : tokenLabel(t)}
                {t === value && <span className="token-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function SwapBox({
  log,
  logErr,
  onBidCreated,
}: {
  log: LogApi["log"];
  logErr: LogApi["logErr"];
  onBidCreated?: () => void;
}) {
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock, evm, fetchCurrentBlockHeight } = useSession();

  // The pair is always NOCK ↔ quote; `pick` keeps it valid on every selection.
  const [sellToken, setSellToken] = useState<IconToken>("NOCK");
  const [buyToken, setBuyToken] = useState<IconToken>("USDC");
  const [nockAmount, setNockAmount] = useState("");
  const [quoteAmount, setQuoteAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [nockUsd, setNockUsd] = useState<number | null>(null);

  const sellingNock = sellToken === "NOCK";
  const quoteToken = (sellingNock ? buyToken : sellToken) as TokenKey;

  useEffect(() => {
    void price.getNockUsd().then((usd) => setNockUsd(usd ?? null));
  }, []);

  function flip(): void {
    setSellToken(buyToken);
    setBuyToken(sellToken);
  }

  /**
   * Select `tok` on one side, keeping the pair valid:
   *  - picking the opposite side's token flips the direction (Uniswap behavior),
   *  - two quote tokens can't face each other — the other side snaps to NOCK,
   *  - identical tokens on both sides are impossible by construction.
   */
  function pick(side: "sell" | "buy", tok: IconToken): void {
    const other = side === "sell" ? buyToken : sellToken;
    if (tok === other) {
      flip();
      return;
    }
    let nextSell = side === "sell" ? tok : sellToken;
    let nextBuy = side === "buy" ? tok : buyToken;
    if (nextSell !== "NOCK" && nextBuy !== "NOCK") {
      if (side === "sell") nextBuy = "NOCK";
      else nextSell = "NOCK";
    }
    setSellToken(nextSell);
    setBuyToken(nextBuy);
  }

  const wnockReady = Boolean(TOKENS.WNOCK.htlc);
  const nockNum = parseFloat(nockAmount);
  const quoteNum = parseFloat(quoteAmount);
  const rate =
    nockNum > 0 && quoteNum > 0
      ? quoteToken === "USDC"
        ? `≈ $${(quoteNum / nockNum).toFixed(4)} per NOCK`
        : `≈ ${(quoteNum / nockNum).toFixed(4)} wNOCK per NOCK`
      : "";
  const marketHint =
    nockUsd != null && quoteToken === "USDC" ? `market ≈ $${nockUsd.toFixed(4)}` : "";

  const ready = !!nock && !!evm;
  const actionLabel = sellingNock
    ? `Sell NOCK for ${tokenLabel(quoteToken)}`
    : `Buy NOCK with ${tokenLabel(quoteToken)}`;

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!nock) throw new Error("Connect Iris (Nockchain wallet).");
      if (!evm) throw new Error("Connect a Base wallet.");
      if (belowMinNock(nockNum)) {
        throw new Error(minNockAmountError());
      }
      if (!Number.isFinite(quoteNum) || quoteNum < minQuote(quoteToken)) {
        throw new Error(
          quoteToken === "USDC"
            ? "Minimum USDC amount is $0.10."
            : "Minimum wNOCK amount is 1 wNOCK."
        );
      }
      const nicks = nockToNicks(nockAmount);
      if (nicks == null) throw new Error("Enter a NOCK amount.");

      if (sellingNock) {
        // Ask: you're the seller — generate the secret and post an open swap.
        const height = await fetchCurrentBlockHeight();
        if (height == null) {
          throw new Error("Couldn't read the chain height from Iris — reconnect and retry.");
        }
        const walletAddress = nock.address ?? nock.pkh;
        const created = await generateSwapAction({
          buyerPkh: "",
          walletAddress,
          sellerEth: evm,
          usdcAmount: quoteAmount.trim(),
          gift: nicks.toString(),
          refundHeight: (height + DEFAULT_NOCK_REFUND_DELTA).toString(),
          token: quoteToken,
        });
        await secretStore.putSellerPreimage(created.swap.hEvm, created.preimageJam);
        await repo.create(created.swap);
        log("Sell order posted — it's live on the marketplace.", true);
        navigate(`/swap/${created.swap.hEvm}`);
      } else {
        // Bid: you're buying NOCK — post a buy order a NOCK holder fills.
        const created = await repo.createBid({
          token: quoteToken,
          quoteAmount: quoteAmount.trim(),
          nockGift: nicks,
          creatorEth: evm,
        });
        log("Buy order posted — it's live on the marketplace.", true);
        onBidCreated?.();
        navigate(`/bid/${created.id}`);
      }
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  /** One side of the box. The amount input follows the token's role: the NOCK
   *  side edits nockAmount, the quote side edits quoteAmount — so amounts stay
   *  with their asset through flips and reselections. */
  const panel = (side: "sell" | "buy") => {
    const token = side === "sell" ? sellToken : buyToken;
    const isNock = token === "NOCK";
    const label =
      side === "sell"
        ? isNock
          ? "You sell"
          : "You pay"
        : isNock
          ? "You buy"
          : "You receive";
    return (
      <div className="swap-panel" key={side}>
        <span className="swap-panel-label">{label}</span>
        <div className="swap-panel-row">
          <input
            className="swap-amount"
            type="number"
            min={isNock ? String(MIN_NOCK_AMOUNT) : String(minQuote(token as TokenKey))}
            placeholder="0"
            value={isNock ? nockAmount : quoteAmount}
            onChange={(e) =>
              isNock ? setNockAmount(e.target.value) : setQuoteAmount(e.target.value)
            }
          />
          <TokenSelect
            value={token}
            onSelect={(t) => pick(side, t)}
            wnockReady={wnockReady}
            ariaLabel={side === "sell" ? "Sell asset" : "Buy asset"}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="swap-interface swap-box">
      {panel("sell")}
      <button
        type="button"
        className="swap-flip"
        aria-label="Flip direction"
        title="Flip direction"
        onClick={flip}
      >
        ⇅
      </button>
      {panel("buy")}
      {(rate || marketHint) && (
        <span className="addr-resolve-hint swap-rate">
          {rate}
          {rate && marketHint ? "  ·  " : ""}
          {marketHint}
        </span>
      )}
      <button
        type="button"
        className={"swap-submit" + (busy ? " busy" : "")}
        disabled={busy || !ready}
        onClick={() => void submit()}
      >
        {busy ? "Posting…" : actionLabel}
      </button>
      {!ready && (
        <span className="addr-resolve-hint">
          Connect both wallets (Base + Nockchain) to place an order.
        </span>
      )}
    </div>
  );
}
