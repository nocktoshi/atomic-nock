/** Dashboard — your swaps AND open buy orders (bids), merged into one list. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { Hex } from "viem";
import type { SwapPublic } from "../swap.js";
import type { Role } from "../app/roles.js";
import { roleForSwap, swapStatus, refundAvailability } from "../app/roles.js";
import { getSwapRepository, type BidPublic } from "../app/repo/swap-repo.js";
import { refundUsdcAction } from "../actions/buyer.js";
import { getHiddenSwaps, hideSwap } from "../app/hidden-swaps.js";
import { useSession } from "./session.js";
import { byNewestSwap } from "./util.js";
import { useLog, LogBox } from "./log.js";
import { SwapOverviewCard } from "./SwapOverviewCard.js";

/** A bid IS a nascent swap — render it through the same card. You're the buyer;
 *  there's no counterparty or on-chain leg yet. */
function bidAsSwap(bid: BidPublic): SwapPublic {
  return {
    hEvm: bid.id as Hex,
    hNock: "" as Digest,
    sellerPkh: "" as Digest,
    buyerPkh: bid.creatorPkh,
    buyerEth: bid.creatorEth,
    nockGift: bid.nockGift,
    usdcAmount: bid.quoteAmount,
    token: bid.token,
    createdAt: bid.createdAt,
    nockRefundHeight: 0n,
    usdcTimelock: 0n,
  };
}

export function Dashboard() {
  const { nock, evm, refundNockAction } = useSession();
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { state: logState, log, logErr } = useLog("Welcome to Atomic Nock. Ready to swap.");

  const [swaps, setSwaps] = useState<SwapPublic[] | null>(null);
  const [bids, setBids] = useState<BidPublic[]>([]);
  const [fetchedFor, setFetchedFor] = useState("");
  const walletKey = `${nock?.pkh ?? ""}:${evm ?? ""}`;
  const loading = !!(nock || evm) && fetchedFor !== walletKey;
  const [lookupId, setLookupId] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);

  // Swaps come from the authenticated per-pkh index; bids from the public list,
  // filtered to the connected wallet (bids carry no per-pkh index).
  const loadMine = useCallback(async (): Promise<{
    swaps: SwapPublic[];
    bids: BidPublic[];
  }> => {
    if (!nock) return { swaps: [], bids: [] };
    const keys = [nock.pkh, nock.address].filter(Boolean) as string[];
    const [list, allBids] = await Promise.all([
      repo.listForNockPkh(nock.pkh),
      repo.listBids().catch(() => [] as BidPublic[]),
    ]);
    const hidden = getHiddenSwaps();
    const byId = new Map<string, SwapPublic>();
    for (const s of list) {
      if (!s.hEvm) continue;
      if (hidden.has(s.hEvm.toLowerCase())) continue; // soft-deleted locally
      byId.set(s.hEvm.toLowerCase(), s);
    }
    return {
      swaps: [...byId.values()].sort(byNewestSwap),
      bids: allBids.filter(
        (b) => keys.includes(b.creatorPkh) && !hidden.has(b.id.toLowerCase())
      ),
    };
  }, [nock, repo]);

  const refreshSwaps = useCallback(async () => {
    // Track the full walletKey in `fetchedFor` so `loading` clears on refresh.
    try {
      const mine = await loadMine();
      setSwaps(mine.swaps);
      setBids(mine.bids);
      setFetchedFor(walletKey);
    } catch (e) {
      logErr(e);
    }
  }, [loadMine, walletKey, logErr]);

  useEffect(() => {
    if (!nock && !evm) return;
    let alive = true;
    const key = walletKey;
    void (async () => {
      try {
        const mine = await loadMine();
        if (!alive) return;
        setSwaps(mine.swaps);
        setBids(mine.bids);
        setFetchedFor(key);
      } catch (e) {
        if (alive) logErr(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [nock, evm, walletKey, loadMine, logErr]);

  function openSwap(swap: SwapPublic): void {
    navigate(`/swap/${swap.hEvm}`);
  }

  async function doCancel(swap: SwapPublic): Promise<void> {
    try {
      await repo.cancel(swap.hEvm);
      log("Open order cancelled and delisted.", true);
      await refreshSwaps();
    } catch (e) {
      logErr(e);
    }
  }

  async function doCancelBid(id: string): Promise<void> {
    try {
      await repo.cancelBid(id);
      log("Buy order cancelled and delisted.", true);
      await refreshSwaps();
    } catch (e) {
      logErr(e);
    }
  }

  async function doRefund(swap: SwapPublic, role: Role): Promise<void> {
    try {
      if (role === "buyer") {
        const { hash } = await refundUsdcAction({ swap });
        log(`USDC refund sent.\ntx: ${hash}`, true);
      } else {
        const { txId } = await refundNockAction({ swap });
        log(`NOCK refund sent.\ntx: ${txId}`, true);
      }
      await repo.put(swap);
      await refreshSwaps();
    } catch (e) {
      logErr(e);
    }
  }

  async function doLookup(): Promise<void> {
    if (lookupBusy) return;
    setLookupBusy(true);
    try {
      const id = lookupId.trim();
      if (!id) throw new Error("Paste a swap id");
      const swap = await repo.get(id);
      if (!swap) throw new Error("No swap found for that id");
      navigate(`/swap/${swap.hEvm}`);
    } catch (e) {
      logErr(e);
    } finally {
      setLookupBusy(false);
    }
  }

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000
    );
    return () => window.clearInterval(timer);
  }, []);
  const conn = {
    eth: evm,
    nock: nock ? { pkh: nock.pkh, address: nock.address } : null,
  };

  return (
    <section className="panel">
      <h2 className="flow-title">Your swaps</h2>
      <LogBox state={logState} />

      <div className="swaps-box">
        {loading ? (
          <p className="hint">Loading your swaps…</p>
        ) : swaps == null ? null : swaps.length === 0 && bids.length === 0 ? (
          <p className="hint">No swaps yet for the connected wallet(s).</p>
        ) : (
          [
            ...bids.map((bid) => ({ bid, swap: bidAsSwap(bid) })),
            ...swaps.map((swap) => ({ bid: undefined, swap })),
          ]
            .sort((a, b) => byNewestSwap(a.swap, b.swap))
            .map(({ bid, swap }) => {
              // An open bid is a nascent swap: you're the buyer, nothing is
              // on-chain, and "open" routes to the bid page instead.
              if (bid) {
                return (
                  <SwapOverviewCard
                    key={`bid:${bid.id}`}
                    swap={swap}
                    role="buyer"
                    status="created"
                    refund={{ eth: false, nock: false }}
                    onOpen={() => navigate(`/bid/${bid.id}`)}
                    onRefund={() => {}}
                    onCancel={() => void doCancelBid(bid.id)}
                    onHide={() => {
                      hideSwap(bid.id);
                      log("Order hidden.", true);
                      void refreshSwaps();
                    }}
                  />
                );
              }
              const role = roleForSwap(swap, conn) ?? "buyer";
              const refund = refundAvailability(swap, { nowSec, nockHeight: null });
              // Height isn't fetched here; the NOCK refund action re-checks it.
              if (role === "seller") {
                refund.nock =
                  !!swap.lockFirstName && !swap.nockClaimTxId && !swap.nockRefundTxId;
              }
              // Either participant can cancel while nothing is on-chain (covers
              // open orders AND filled bids the counterparty never acted on).
              const cancellable =
                !swap.lockFirstName && !swap.nockLockTxId && !swap.usdcLockTxHash;
              return (
                <SwapOverviewCard
                  key={swap.hEvm}
                  swap={swap}
                  role={role}
                  status={swapStatus(swap)}
                  refund={refund}
                  onOpen={() => openSwap(swap)}
                  onRefund={() => void doRefund(swap, role)}
                  onCancel={cancellable ? () => void doCancel(swap) : undefined}
                  onHide={() => {
                    hideSwap(swap.hEvm ?? "");
                    log("Swap deleted.", true);
                    void refreshSwaps();
                  }}
                />
              );
            })
        )}
      </div>

      <label htmlFor="swap-id">Open a swap by ID</label>
      <div className="lookup-row">
        <input
          id="swap-id"
          placeholder="Swap ID (0x…) from the seller"
          value={lookupId}
          onChange={(e) => setLookupId(e.target.value)}
        />
        <button
          type="button"
          className={lookupBusy ? "busy" : undefined}
          disabled={lookupBusy}
          onClick={doLookup}
        >
          Open swap
        </button>
      </div>

      <div className="create-row">
        <button type="button" onClick={() => navigate("/")}>
          Back to market
        </button>
        <button type="button" onClick={() => navigate("/new")}>
          Direct swap (advanced)
        </button>
      </div>
    </section>
  );
}
