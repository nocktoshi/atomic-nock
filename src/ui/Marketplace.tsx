/** Marketplace — browse open (buyer-less) swaps and fill one. Public: browsing
 *  needs no wallet; filling goes through the swap page's claim flow (sign-in). */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SwapPublic } from "../swap.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import {
  nicksToNock,
  quoteDisplay,
  short,
  swapCreatedAt,
  useResolvedNock,
} from "./util.js";

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

function OpenSwapCard({
  swap,
  nowSec,
  mine,
  onFill,
}: {
  swap: SwapPublic;
  nowSec: number;
  mine: boolean;
  onFill(): void;
}) {
  const quote = quoteDisplay(swap);
  const seller = useResolvedNock(swap.sellerPkh, short(swap.sellerPkh, 8, 6));
  return (
    <div className="swap-card overview">
      <div className="swap-card-title">
        <span>
          {nicksToNock(swap.nockGift)} NOCK → {quote.amountLabel}
        </span>
        <div className="swap-card-title-badges">
          <span className="swap-badge">{quote.symbol}</span>
          {mine && <span className="swap-badge">Your order</span>}
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
          <span className="k">Seller</span>
          <span className="v" title={seller.title ?? swap.sellerPkh}>
            {seller.text}
          </span>
        </div>
        <div className="swap-card-row">
          <span className="k">Posted</span>
          <span className="v">{ageLabel(swapCreatedAt(swap), nowSec)}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">Window</span>
          <span className="v">{expiryLabel(swap.usdcTimelock, nowSec)}</span>
        </div>
      </div>
      <div className="card-actions">
        <button type="button" disabled={mine} title={mine ? "You can't fill your own order" : undefined} onClick={onFill}>
          {mine ? "Your order" : "Fill order"}
        </button>
      </div>
    </div>
  );
}

export function Marketplace() {
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock } = useSession();
  const { state: logState, logErr } = useLog("Open orders — fill one to start a swap.");

  const [swaps, setSwaps] = useState<SwapPublic[] | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await repo.listOpen();
        if (alive) setSwaps(list);
      } catch (e) {
        if (alive) {
          setSwaps([]);
          logErr(e);
        }
      }
    })();
    const timer = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000
    );
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [repo, logErr]);

  return (
    <section className="panel">
      <h2 className="flow-title">Marketplace</h2>
      <LogBox state={logState} />
      <div className="swaps-box">
        {swaps == null ? (
          <p className="hint">Loading open orders…</p>
        ) : swaps.length === 0 ? (
          <p className="hint">
            No open orders right now. Create one — it lists here automatically.
          </p>
        ) : (
          swaps.map((swap) => (
            <OpenSwapCard
              key={swap.hEvm}
              swap={swap}
              nowSec={nowSec}
              mine={!!nock && swap.sellerPkh === nock.pkh}
              onFill={() => navigate(`/swap/${swap.hEvm}`)}
            />
          ))
        )}
      </div>
      <div className="create-row">
        <button type="button" onClick={() => navigate("/new")}>
          Create new swap (sell NOCK)
        </button>
      </div>
    </section>
  );
}
