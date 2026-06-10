/** Top-level app shell: global wallet bar + routes. */
import { useEffect, useMemo, useState } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
import type { SwapPublic, DraftSwap } from "../swap.js";
import { roleForSwap } from "../app/roles.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { SessionProvider, useSession } from "./session.js";
import { WalletBar } from "./WalletBar.js";
import { Dashboard } from "./Dashboard.js";
import { SellerWizard } from "./SellerWizard.js";
import { BuyerWizard } from "./BuyerWizard.js";
import { NICKS_PER_NOCK } from "./util.js";

function BackToDashboard() {
  const navigate = useNavigate();
  return (
    <button type="button" className="role-back" onClick={() => navigate("/")}>
      ← Dashboard
    </button>
  );
}

/** Create a new swap as the seller. Starts from a blank draft swap. */
function NewSwapRoute() {
  const [swap, setSwap] = useState<DraftSwap>(() => ({
    nockGift: BigInt(50 * NICKS_PER_NOCK),
    usdcAmount: "1.00",
  }));
  return (
    <div className="role-flow">
      <BackToDashboard />
      <SellerWizard swap={swap} setSwap={setSwap} />
    </div>
  );
}

/** Open an existing swap by id and route to the right wizard. */
function SwapRoute() {
  const { id } = useParams<{ id: string }>();
  const { nock, evm } = useSession();
  const repo = useMemo(() => getSwapRepository(), []);

  const swapId = id ?? "";
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [swap, setSwap] = useState<DraftSwap>({});
  const [found, setFound] = useState(false);

  useEffect(() => {
    let alive = true;
    repo
      .get(swapId)
      .then((s) => {
        if (!alive) return;
        setLoadedForId(swapId);
        if (s) {
          setSwap(s);
          setFound(true);
        } else {
          setSwap({});
          setFound(false);
        }
      })
      .catch(() => {
        if (!alive) return;
        setLoadedForId(swapId);
        setSwap({});
        setFound(false);
      });
    return () => {
      alive = false;
    };
  }, [swapId, repo]);

  const status =
    loadedForId !== swapId ? "loading" : found ? "ready" : "notfound";

  const walletConn = useMemo(
    () =>
      nock ? { eth: evm, nock: { pkh: nock.pkh, address: nock.address } } : { eth: evm, nock: null },
    [evm, nock]
  );

  const role = useMemo(
    () =>
      status === "ready"
        ? roleForSwap(swap as SwapPublic, walletConn) ?? "buyer"
        : "buyer",
    [status, swap, walletConn]
  );

  if (status === "loading") {
    return (
      <div className="role-flow">
        <BackToDashboard />
        <p className="hint">Loading swap…</p>
      </div>
    );
  }

  if (status === "notfound") {
    return (
      <div className="role-flow">
        <BackToDashboard />
        <p className="hint">Swap not found: {id}</p>
      </div>
    );
  }

  return (
    <div className="role-flow">
      <BackToDashboard />
      {role === "seller" ? (
        <SellerWizard key={`seller-${swap.hEvm}`} swap={swap} setSwap={setSwap} />
      ) : (
        <BuyerWizard key={`buyer-${swap.hEvm}`} swap={swap} setSwap={setSwap} />
      )}
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <div className="wallet-bar-wrap">
        <WalletBar />
      </div>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<NewSwapRoute />} />
        <Route path="/swap/:id" element={<SwapRoute />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </SessionProvider>
  );
}
