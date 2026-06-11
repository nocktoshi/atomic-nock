/** Bid page (`/bid/:id`) — a buy order's home, mirroring the swap page.
 *  The creator sees their open order (share link, cancel, waiting status);
 *  anyone else sees the fill flow (sell native NOCK to the bidder). Once
 *  filled, the bid id resolves to the swap that replaced it and the page
 *  forwards there — the creator just keeps this tab open. */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DEFAULT_NOCK_REFUND_DELTA } from "../config.js";
import { fillBidAction } from "../actions/seller.js";
import { getSwapRepository, type BidPublic } from "../app/repo/swap-repo.js";
import { secretStore } from "../app/storage/secret-store.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import {
  copyText,
  nicksToNock,
  quoteDisplay,
  short,
  useResolvedNock,
} from "./util.js";

/** Re-check the bid this often — the creator's tab discovers its fill. */
const POLL_MS = 30_000;

export function BidPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { nock, evm, fetchCurrentBlockHeight } = useSession();
  const { state: logState, log, logErr } = useLog();

  const [bid, setBid] = useState<BidPublic | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy link");

  // Load + poll. A filled bid forwards to its swap (the creator resumes there:
  // verify the NOCK lock, then lock the quote token).
  useEffect(() => {
    let alive = true;
    async function check(): Promise<void> {
      try {
        const found = await repo.getBid(id ?? "");
        if (!alive) return;
        if (found?.filledHEvm) {
          navigate(`/swap/${found.filledHEvm}`, { replace: true });
          return;
        }
        setBid(found?.bid ?? null);
      } catch {
        if (alive) setBid(null);
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, repo, navigate]);

  const buyer = useResolvedNock(bid?.creatorPkh, short(bid?.creatorPkh, 8, 6));

  if (bid === undefined) return <p className="hint">Loading order…</p>;
  if (bid === null) {
    return <p className="hint">This buy order is gone — already filled or cancelled.</p>;
  }

  const quote = quoteDisplay({
    token: bid.token,
    usdcAmount: bid.quoteAmount,
    nockGift: bid.nockGift,
  });
  const mine = !!nock && (nock.pkh === bid.creatorPkh || nock.address === bid.creatorPkh);
  const ready = !!nock && !!evm && !mine;
  const shareLink = `${window.location.origin}/bid/${bid.id}`;

  async function copyLink(): Promise<void> {
    if (await copyText(shareLink)) {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    }
  }

  async function cancel(): Promise<void> {
    if (busy || !bid) return;
    setBusy(true);
    try {
      await repo.cancelBid(bid.id);
      log("Buy order cancelled and delisted.", true);
      navigate("/");
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function fill(): Promise<void> {
    if (busy || !bid) return;
    setBusy(true);
    try {
      if (!nock) throw new Error("Connect Iris (Nockchain wallet).");
      if (!evm) throw new Error("Connect a Base wallet.");
      const height = await fetchCurrentBlockHeight();
      if (height == null) {
        throw new Error("Couldn't read the chain height from Iris — reconnect and retry.");
      }
      const { swap, preimageJam } = await fillBidAction({
        bid,
        walletAddress: nock.address ?? nock.pkh,
        sellerEth: evm,
        refundHeight: (height + DEFAULT_NOCK_REFUND_DELTA).toString(),
      });
      await secretStore.putSellerPreimage(swap.hEvm, preimageJam);
      const filled = await repo.fillBid(bid.id, swap);
      log("Order filled — lock your NOCK to continue.", true);
      navigate(`/swap/${filled.hEvm}`);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  // --- Creator's view: their open order, like a seller's unclaimed swap ------
  if (mine) {
    return (
      <section className="panel">
        <h2 className="flow-title">Buy NOCK — your order</h2>
        <div className="swap-order-summary">
          <div className="swap-card-row">
            <span className="k">You buy</span>
            <span className="v">{nicksToNock(bid.nockGift)} NOCK</span>
          </div>
          <div className="swap-card-row">
            <span className="k">You pay</span>
            <span className="v">{quote.amountLabel} on Base</span>
          </div>
          {quote.priceLabel && (
            <div className="swap-card-row">
              <span className="k">Price</span>
              <span className="v">{quote.priceLabel}</span>
            </div>
          )}
        </div>
        <p className="fee-disclaimer">
          Waiting for a seller to fill this order — it's live on the marketplace.
          When someone fills it they lock NOCK first; this page then moves to the
          swap automatically, where you'll verify the lock and pay {quote.symbol}.
        </p>
        <LogBox state={logState} />
        <label>Order link (share with a seller)</label>
        <div className="share-link-row">
          <input readOnly value={shareLink} />
          <button type="button" onClick={() => void copyLink()}>
            {copyLabel}
          </button>
        </div>
        <div className="card-actions">
          <button
            type="button"
            className={busy ? "busy" : undefined}
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy ? "Cancelling…" : "Cancel order"}
          </button>
        </div>
      </section>
    );
  }

  // --- Anyone else: fill the order (sell native NOCK to the bidder) ---------
  return (
    <section className="panel">
      <h2 className="flow-title">Sell NOCK — fill buy order</h2>
      <div className="swap-order-summary">
        <div className="swap-card-row">
          <span className="k">You sell</span>
          <span className="v">{nicksToNock(bid.nockGift)} NOCK</span>
        </div>
        <div className="swap-card-row">
          <span className="k">You receive</span>
          <span className="v">{quote.amountLabel} on Base</span>
        </div>
        {quote.priceLabel && (
          <div className="swap-card-row">
            <span className="k">Price</span>
            <span className="v">{quote.priceLabel}</span>
          </div>
        )}
        <div className="swap-card-row">
          <span className="k">Buyer</span>
          <span className="v" title={buyer.title ?? bid.creatorPkh}>
            {buyer.text}
          </span>
        </div>
      </div>
      <p className="fee-disclaimer">
        Filling generates the swap secret on this device: you lock NOCK first, the
        buyer locks {quote.symbol} on Base, then you withdraw it (revealing the
        secret) and the buyer claims your NOCK. A 0.5% protocol fee comes out of
        the {quote.symbol} withdrawal.
      </p>
      <div className="card-actions">
        <button
          type="button"
          className={busy ? "busy" : undefined}
          disabled={busy || !ready}
          onClick={() => void fill()}
        >
          {busy ? "Filling…" : `Sell ${nicksToNock(bid.nockGift)} NOCK`}
        </button>
      </div>
      {!nock || !evm ? (
        <p className="hint">Connect both wallets (Base + Nockchain) to fill this order.</p>
      ) : null}
      <LogBox state={logState} />
    </section>
  );
}
