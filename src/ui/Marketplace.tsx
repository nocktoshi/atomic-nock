/** Marketplace — the app's front page. Order entry (SwapBox) up top, then the
 *  order book: asks (sellers of native NOCK) and bids (buy orders paying
 *  USDC/wNOCK). Browsing is public; filling signs in through the wizards. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SwapPublic } from "../swap.js";
import type { TokenKey } from "../config.js";
import { getSwapRepository, type BidPublic } from "../app/repo/swap-repo.js";
import { createPriceProvider } from "../market/price.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { SwapBox } from "./SwapBox.js";
import { TradeNav } from "./TradeNav.js";
import {
  nicksToNock,
  quoteDisplay,
  short,
  swapCreatedAt,
  useResolvedNock,
  NICKS_PER_NOCK,
} from "./util.js";

const price = createPriceProvider();

/** "3m ago" / "2h ago" age label from epoch seconds. */
function ageLabel(createdAt: number, nowSec: number): string {
  const s = Math.max(0, nowSec - createdAt);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "expires in 11h 32m" from the quote-leg timelock. */
function expiryLabel(usdcTimelock: bigint, nowSec: number): string {
  const s = Number(usdcTimelock) - nowSec;
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `expires in ${h}h ${m}m` : `expires in ${m}m`;
}

/** One normalized order-book row (an ask = open swap, or a bid = buy order). */
interface MarketRow {
  /** From the VIEWER's perspective: filling an ask buys NOCK, a bid sells it. */
  kind: "ask" | "bid";
  key: string;
  token: TokenKey;
  quoteAmount: string;
  nockGift: bigint;
  createdAt: number;
  /** Counterparty's Nockchain identity (ask: seller, bid: buyer). */
  party: string;
  expiresAt?: number;
  mine: boolean;
}

/** Quote-per-NOCK; NaN-safe for malformed rows (sorted last). */
function pricePerNock(row: MarketRow): number {
  const nock = Number(row.nockGift) / NICKS_PER_NOCK;
  const quote = parseFloat(row.quoteAmount);
  return nock > 0 && Number.isFinite(quote) ? quote / nock : NaN;
}

/** USD-equivalent price for cross-token sorting (wNOCK ratio × market $NOCK). */
function usdPrice(row: MarketRow, nockUsd: number | null): number {
  const p = pricePerNock(row);
  if (!Number.isFinite(p)) return Number.POSITIVE_INFINITY;
  return row.token === "USDC" ? p : p * (nockUsd ?? 1);
}

type SideFilter = "all" | "buy" | "sell";
type TokenFilter = "all" | TokenKey;
type SortKey = "newest" | "price-asc" | "price-desc" | "amount";

function MarketCard({
  row,
  nowSec,
  onAction,
  onCancel,
}: {
  row: MarketRow;
  nowSec: number;
  onAction(): void;
  onCancel?: () => void;
}) {
  const quote = quoteDisplay({
    token: row.token,
    usdcAmount: row.quoteAmount,
    nockGift: row.nockGift,
  });
  const party = useResolvedNock(row.party, short(row.party, 8, 6));
  const buying = row.kind === "ask"; // the viewer would be buying NOCK
  return (
    <div className="swap-card overview">
      <div className="swap-card-title">
        <span>
          {buying
            ? `${nicksToNock(row.nockGift)} NOCK for ${quote.amountLabel}`
            : `${quote.amountLabel} for ${nicksToNock(row.nockGift)} NOCK`}
        </span>
        <div className="swap-card-title-badges">
          <span className={`swap-badge market-side ${buying ? "ask" : "bid"}`}>
            {buying ? "Buy NOCK" : "Sell NOCK"}
          </span>
          <span className="swap-badge">{quote.symbol}</span>
          {row.mine && <span className="swap-badge">Your order</span>}
        </div>
      </div>
      <div>
        {quote.priceLabel && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">{quote.priceLabel}</span>
          </div>
        )}
        <div className="swap-card-row">
          <span className="k">{buying ? "Seller" : "Buyer"}</span>
          <span className="v" title={party.title ?? row.party}>
            {party.text}
          </span>
        </div>
        <div className="swap-card-row">
          <span className="k">Posted</span>
          <span className="v">{ageLabel(row.createdAt, nowSec)}</span>
        </div>
        {row.expiresAt != null && (
          <div className="swap-card-row">
            <span className="k">Window</span>
            <span className="v">{expiryLabel(BigInt(row.expiresAt), nowSec)}</span>
          </div>
        )}
      </div>
      <div className="card-actions">
        {row.mine && onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel order
          </button>
        )}
        <button
          type="button"
          disabled={row.mine}
          title={row.mine ? "You can't fill your own order" : undefined}
          onClick={onAction}
        >
          {row.mine ? "Your order" : buying ? "Buy NOCK" : "Sell NOCK"}
        </button>
      </div>
    </div>
  );
}

export function Marketplace() {
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock } = useSession();
  const { state: logState, log, logErr } = useLog(
    "Buy or sell native NOCK — post an order above or fill one below."
  );

  const [asks, setAsks] = useState<SwapPublic[] | null>(null);
  const [bids, setBids] = useState<BidPublic[] | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [nockUsd, setNockUsd] = useState<number | null>(null);

  const [side, setSide] = useState<SideFilter>("all");
  const [token, setToken] = useState<TokenFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");

  const refresh = useCallback(async () => {
    try {
      const { swaps, bids } = await repo.listFeed();
      setAsks(swaps);
      setBids(bids);
    } catch (e) {
      setAsks([]);
      setBids([]);
      logErr(e);
    }
  }, [repo, logErr]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    void price.getNockUsd().then((usd) => setNockUsd(usd ?? null));
    const timer = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000
    );
    return () => window.clearInterval(timer);
  }, [refresh]);

  const myKeys = useMemo(() => {
    const keys = new Set<string>();
    if (nock?.pkh) keys.add(nock.pkh);
    if (nock?.address) keys.add(nock.address);
    return keys;
  }, [nock]);

  const rows = useMemo<MarketRow[]>(() => {
    const out: MarketRow[] = [];
    for (const s of asks ?? []) {
      out.push({
        kind: "ask",
        key: s.hEvm,
        token: s.token ?? "USDC",
        quoteAmount: s.usdcAmount ?? "",
        nockGift: s.nockGift,
        createdAt: swapCreatedAt(s),
        party: s.sellerPkh,
        expiresAt: Number(s.usdcTimelock),
        mine: myKeys.has(s.sellerPkh),
      });
    }
    for (const b of bids ?? []) {
      out.push({
        kind: "bid",
        key: b.id,
        token: b.token,
        quoteAmount: b.quoteAmount,
        nockGift: b.nockGift,
        createdAt: b.createdAt ?? 0,
        party: b.creatorPkh,
        mine: myKeys.has(b.creatorPkh),
      });
    }

    const filtered = out.filter(
      (r) =>
        (side === "all" || (side === "buy" ? r.kind === "ask" : r.kind === "bid")) &&
        (token === "all" || r.token === token)
    );

    switch (sort) {
      case "price-asc":
        filtered.sort((a, b) => usdPrice(a, nockUsd) - usdPrice(b, nockUsd));
        break;
      case "price-desc":
        filtered.sort((a, b) => usdPrice(b, nockUsd) - usdPrice(a, nockUsd));
        break;
      case "amount":
        filtered.sort((a, b) => Number(b.nockGift - a.nockGift));
        break;
      default:
        filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
    return filtered;
  }, [asks, bids, side, token, sort, myKeys, nockUsd]);

  async function cancelRow(row: MarketRow): Promise<void> {
    try {
      if (row.kind === "ask") await repo.cancel(row.key);
      else await repo.cancelBid(row.key);
      log("Order cancelled and delisted.", true);
      await refresh();
    } catch (e) {
      logErr(e);
    }
  }

  const loading = asks == null || bids == null;

  return (
    <>
      <TradeNav />
      <section className="panel">
        <h2 className="flow-title">OTC NOCK</h2>
        <SwapBox log={log} logErr={logErr} onBidCreated={() => void refresh()} />
        <LogBox state={logState} />

        <div className="market-controls">
          <div className="market-tabs" role="tablist" aria-label="Order side">
            {(
              [
                ["all", "All orders"],
                ["buy", "Buy NOCK"],
                ["sell", "Sell NOCK"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={side === value}
                className={"market-tab" + (side === value ? " active" : "")}
                onClick={() => setSide(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="market-filters">
            <select
              aria-label="Token filter"
              value={token}
              onChange={(e) => setToken(e.target.value as TokenFilter)}
            >
              <option value="all">All tokens</option>
              <option value="USDC">USDC</option>
              <option value="WNOCK">wNOCK</option>
            </select>
            <select
              aria-label="Sort orders"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="newest">Newest</option>
              <option value="price-asc">Price ↑</option>
              <option value="price-desc">Price ↓</option>
              <option value="amount">NOCK amount</option>
            </select>
          </div>
        </div>

        <div className="swaps-box">
          {loading ? (
            <p className="hint">Loading orders…</p>
          ) : rows.length === 0 ? (
            <p className="hint">
              No open orders match. Post one above — it lists here automatically.
            </p>
          ) : (
            rows.map((row) => (
              <MarketCard
                key={`${row.kind}:${row.key}`}
                row={row}
                nowSec={nowSec}
                onAction={() =>
                  navigate(row.kind === "ask" ? `/swap/${row.key}` : `/bid/${row.key}`)
                }
                onCancel={row.mine ? () => void cancelRow(row) : undefined}
              />
            ))
          )}
        </div>

      </section>
    </>
  );
}
