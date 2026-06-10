/** Dashboard — your swaps, lookup by id, create new (React port of role-select.ts). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SwapPublic } from "../swap.js";
import type { Role } from "../app/roles.js";
import { roleForSwap, swapStatus, refundAvailability } from "../app/roles.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { refundUsdcAction } from "../actions/buyer.js";
import { getHiddenSwaps, hideSwap } from "../app/hidden-swaps.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";
import { SwapOverviewCard } from "./SwapOverviewCard.js";

export function Dashboard() {
  const { nock, evm, refundNockAction } = useSession();
  const navigate = useNavigate();
  const repo = useMemo(() => getSwapRepository(), []);
  const { state: logState, log, logErr } = useLog("Welcome to Atomic Nock. Ready to swap.");

  const [swaps, setSwaps] = useState<SwapPublic[] | null>(null);
  const [fetchedFor, setFetchedFor] = useState("");
  const walletKey = `${nock?.pkh ?? ""}:${evm ?? ""}`;
  const loading = !!(nock || evm) && fetchedFor !== walletKey;
  const [lookupId, setLookupId] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);

  const refreshSwaps = useCallback(async () => {
    if (!nock && !evm) return;
    const key = `${nock?.pkh ?? ""}:${evm ?? ""}`;
    try {
      const lists = await Promise.all([
        evm ? repo.listForAddress(evm) : Promise.resolve([]),
        nock ? repo.listForNockPkh(nock.pkh) : Promise.resolve([]),
      ]);
      const hidden = getHiddenSwaps();
      const byId = new Map<string, SwapPublic>();
      for (const s of lists.flat()) {
        if (!s.hEvm) continue;
        if (hidden.has(s.hEvm.toLowerCase())) continue; // soft-deleted locally
        byId.set(s.hEvm.toLowerCase(), s);
      }
      setSwaps([...byId.values()]);
      setFetchedFor(key);
    } catch (e) {
      logErr(e);
    }
  }, [nock, evm, repo, logErr]);

  useEffect(() => {
    if (!nock && !evm) return;
    let alive = true;
    const key = walletKey;
    void (async () => {
      try {
        const lists = await Promise.all([
          evm ? repo.listForAddress(evm) : Promise.resolve([]),
          nock ? repo.listForNockPkh(nock.pkh) : Promise.resolve([]),
        ]);
        if (!alive) return;
        const hidden = getHiddenSwaps();
        const byId = new Map<string, SwapPublic>();
        for (const s of lists.flat()) {
          if (!s.hEvm) continue;
          if (hidden.has(s.hEvm.toLowerCase())) continue;
          byId.set(s.hEvm.toLowerCase(), s);
        }
        setSwaps([...byId.values()]);
        setFetchedFor(key);
      } catch (e) {
        if (alive) logErr(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [nock, evm, repo, walletKey, logErr]);

  function openSwap(swap: SwapPublic): void {
    navigate(`/swap/${swap.hEvm}`);
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
        ) : swaps == null ? null : swaps.length === 0 ? (
          <p className="hint">No swaps yet for the connected wallet(s).</p>
        ) : (
          swaps.map((swap) => {
            const role = roleForSwap(swap, conn) ?? "buyer";
            const refund = refundAvailability(swap, { nowSec, nockHeight: null });
            // Height isn't fetched here; the NOCK refund action re-checks it.
            if (role === "seller") {
              refund.nock =
                !!swap.lockFirstName && !swap.nockClaimTxId && !swap.nockRefundTxId;
            }
            return (
              <SwapOverviewCard
                key={swap.hEvm}
                swap={swap}
                role={role}
                status={swapStatus(swap)}
                refund={refund}
                onOpen={() => openSwap(swap)}
                onRefund={() => void doRefund(swap, role)}
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
        <button type="button" onClick={() => navigate("/new")}>
          Create new swap (sell NOCK)
        </button>
      </div>
    </section>
  );
}
