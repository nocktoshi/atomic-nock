import type { SwapSession } from "../app/state.js";
import type { SwapPublic } from "../swap.js";
import type { Role } from "../app/roles.js";
import { roleForSwap, swapStatus, refundAvailability } from "../app/roles.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { connectIrisWallet } from "../nock/wallet.js";
import { connectEvmWallet } from "../evm/wallet.js";
import { createPriceProvider } from "../market/price.js";
import { buildSellerWizard } from "./seller-wizard.js";
import { buildBuyerWizard } from "./buyer-wizard.js";
import { swapOverviewCard } from "./swap-overview-card.js";
import { refundUsdcAction } from "../actions/buyer.js";
import { refundNockAction } from "../actions/seller.js";
import { getHiddenSwaps, hideSwap } from "../app/hidden-swaps.js";
import { el, runBusy } from "./dom.js";
import { log, logErr, setWalletStatus } from "./log.js";

const price = createPriceProvider();

/** Dashboard: connect wallets, auto-list your swaps, look up by id, create new. */
export function renderDashboard(app: HTMLElement, session: SwapSession): void {
  const repo = getSwapRepository();

  const priceBanner = el("div", { class: "price-banner", text: "" });
  const irisStatus = el("span", { class: "wallet-status", text: "Iris: not connected" });
  const evmStatus = el("span", { class: "wallet-status", text: "MetaMask: not connected" });
  const swapsBox = el("div", { class: "swaps-box" });
  const dashLog = el("div", { class: "log", text: "Welcome to Atomic Nock. Ready to swap." });

  if (session.nock) setWalletStatus(irisStatus, "iris", true, session.nock.pkh.slice(0, 16) + "…");
  if (session.evm) setWalletStatus(evmStatus, "evm", true, session.evm);

  void loadPrice();

  function home(): void {
    renderDashboard(app, session);
  }

  function openWizard(role: Role): void {
    session.activeRole = role;
    const container = el("div", { class: "role-flow" });
    const back = el("button", { type: "button", class: "role-back", text: "← Dashboard" });
    back.onclick = home;
    container.append(back);
    if (role === "seller") buildSellerWizard(container, session);
    else buildBuyerWizard(container, session);
    app.replaceChildren(container);
  }

  function openSwap(swap: SwapPublic, role: Role): void {
    session.activeSwap = swap;
    session.buyerPreimageJam = null;
    session.evmSwapId = null;
    openWizard(role);
  }

  async function loadPrice(): Promise<void> {
    const usd = await price.getNockUsd();
    priceBanner.textContent = usd != null ? `NOCK ≈ $${usd.toFixed(4)} USD` : "";
  }

  async function refreshSwaps(): Promise<void> {
    if (!session.nock && !session.evm) return;
    swapsBox.replaceChildren(el("p", { class: "hint", text: "Loading your swaps…" }));
    try {
      const lists = await Promise.all([
        session.evm ? repo.listForAddress(session.evm) : Promise.resolve([]),
        session.nock ? repo.listForNockPkh(session.nock.pkh) : Promise.resolve([]),
      ]);
      const hidden = getHiddenSwaps();
      const byId = new Map<string, SwapPublic>();
      for (const s of lists.flat()) {
        if (hidden.has(s.hEvm.toLowerCase())) continue; // soft-deleted locally
        byId.set(s.hEvm.toLowerCase(), s);
      }
      const swaps = [...byId.values()];

      if (!swaps.length) {
        swapsBox.replaceChildren(el("p", { class: "hint", text: "No swaps yet for the connected wallet(s)." }));
        return;
      }

      const conn = { eth: session.evm, pkh: session.nock?.pkh };
      const nowSec = Math.floor(Date.now() / 1000);
      const cards = swaps.map((swap) => {
        const role = roleForSwap(swap, conn) ?? "buyer";
        const refund = refundAvailability(swap, { nowSec, nockHeight: null });
        // Height isn't fetched here; the NOCK refund action re-checks it. Show the
        // NOCK option for a seller whose lock is still outstanding.
        if (role === "seller") {
          refund.nock =
            !!swap.lockFirstName && !swap.nockClaimTxId && !swap.nockRefundTxId;
        }
        return swapOverviewCard({
          swap,
          role,
          status: swapStatus(swap),
          refund,
          onOpen: () => openSwap(swap, role),
          onRefund: () => void doRefund(swap, role),
          onHide: () => {
            hideSwap(swap.hEvm);
            log(dashLog, "Swap hidden from this device (not deleted).", true);
            void refreshSwaps();
          },
        });
      });
      swapsBox.replaceChildren(...cards);
    } catch (e) {
      logErr(dashLog, e);
    }
  }

  async function doRefund(swap: SwapPublic, role: Role): Promise<void> {
    try {
      session.activeSwap = swap;
      if (role === "buyer") {
        const { hash } = await refundUsdcAction({ swap });
        log(dashLog, `USDC refund sent.\ntx: ${hash}`, true);
      } else {
        const { txId } = await refundNockAction({ wallet: session.nock, swap });
        log(dashLog, `NOCK refund sent.\ntx: ${txId}`, true);
      }
      await repo.put(swap);
      await refreshSwaps();
    } catch (e) {
      logErr(dashLog, e);
    }
  }

  // --- connect controls ---
  const irisBtn = el("button", { type: "button", text: "Connect Iris" });
  irisBtn.onclick = () =>
    runBusy(irisBtn, async () => {
      session.nock = await connectIrisWallet();
      setWalletStatus(irisStatus, "iris", true, session.nock.pkh.slice(0, 16) + "…");
      await refreshSwaps();
    }).catch((e) => logErr(dashLog, e));

  const evmBtn = el("button", { type: "button", text: "Connect MetaMask" });
  evmBtn.onclick = () =>
    runBusy(evmBtn, async () => {
      session.evm = await connectEvmWallet();
      setWalletStatus(evmStatus, "evm", true, session.evm);
      await refreshSwaps();
    }).catch((e) => logErr(dashLog, e));

  // --- lookup by id ---
  const lookupInput = el("input", { placeholder: "Swap ID (0x…) from the seller" });
  const lookupBtn = el("button", { type: "button", text: "Open swap" });
  lookupBtn.onclick = () =>
    runBusy(lookupBtn, async () => {
      const id = lookupInput.value.trim();
      if (!id) throw new Error("Paste a swap id");
      const swap = await repo.get(id);
      if (!swap) throw new Error("No swap found for that id");
      const role = roleForSwap(swap, { eth: session.evm, pkh: session.nock?.pkh }) ?? "buyer";
      openSwap(swap, role);
    }).catch((e) => logErr(dashLog, e));

  // --- create new (seller) ---
  const createBtn = el("button", { type: "button", text: "Create new swap (sell NOCK)" });
  createBtn.onclick = () => {
    session.activeSwap = null;
    session.buyerPreimageJam = null;
    session.evmSwapId = null;
    openWizard("seller");
  };

  const panel = el("section", { class: "panel" }, [
    el("h2", { class: "flow-title", text: "Your swaps" }),
    priceBanner,
    el("div", { class: "wallet-row" }, [irisBtn, irisStatus]),
    el("div", { class: "wallet-row" }, [evmBtn, evmStatus]),
    dashLog,
    swapsBox,
    el("label", { text: "Open a swap by ID" }),
    el("div", { class: "lookup-row" }, [lookupInput, lookupBtn]),
    el("div", { class: "create-row" }, [createBtn]),
  ]);

  app.replaceChildren(panel);
  if (session.nock || session.evm) void refreshSwaps();
}
