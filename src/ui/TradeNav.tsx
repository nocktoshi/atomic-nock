/** Swap Native ↔ OTC Book navigation (home + marketplace). */
import { useNavigate, useLocation } from "react-router-dom";

export function TradeNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const onHome = pathname === "/";
  const onMarket = pathname === "/market";

  return (
    <nav className="home-nav" aria-label="Swap navigation">
      <button
        type="button"
        className={"any-chain-link" + (onHome ? " active" : "")}
        aria-current={onHome ? "page" : undefined}
        onClick={() => navigate("/")}
      >
        Native Swap
      </button>
      <button
        type="button"
        className={"any-chain-link" + (onMarket ? " active" : "")}
        aria-current={onMarket ? "page" : undefined}
        onClick={() => navigate("/market")}
      >
        OTC Order
      </button>
    </nav>
  );
}