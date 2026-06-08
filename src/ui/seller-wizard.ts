import type { SwapSession } from "../app/state.js";
import {
  generateSwapAction,
  lockNockAction,
  withdrawUsdcAction,
} from "../actions/seller.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { secretStore } from "../app/storage/secret-store.js";
import { swapStatus } from "../app/roles.js";
import { isPlausibleWalletAddress, fetchCurrentBlockHeight } from "../nock/balance.js";
import { el, field } from "./dom.js";
import { addressField } from "./address-field.js";
import { mountWizard, type WizardStep } from "./wizard.js";
import { log, logErr } from "./log.js";
import { swapShare } from "./swap-card.js";

/** Build the seller (NOCK → USDC) wizard. Wallets are already connected via the dashboard. */
export function buildSellerWizard(container: HTMLElement, session: SwapSession): void {
  const repo = getSwapRepository();
  const heading = el("h2", { class: "flow-title", text: "Seller (NOCK → USDC)" });
  const wizardRoot = el("div");
  const shareArea = el("div");
  const sharedLog = el("div", { class: "log", text: "" });

  const persist = () => (session.activeSwap ? repo.put(session.activeSwap) : Promise.resolve());

  // Show wallet status in the log on entry.
  const irisLabel = session.nock ? `Iris: ${session.nock.pkh.slice(0, 16)}…` : "Iris: not connected";
  const evmLabel = session.evm ? `MetaMask: ${session.evm}` : "MetaMask: not connected";
  log(sharedLog, `${irisLabel}\n${evmLabel}`, true);

  function refreshShare(): void {
    if (session.activeSwap) {
      shareArea.replaceChildren(
        swapShare(session.activeSwap, JSON.stringify({ swapId: session.activeSwap.hEvm }))
      );
    } else {
      shareArea.replaceChildren();
    }
  }
  refreshShare();

  // --- Step 1: generate swap ------------------------------------------------
  let nockAddrField: ReturnType<typeof addressField>;
  let buyerNockField: ReturnType<typeof addressField>;
  let giftInput: HTMLInputElement;
  let usdcInput: HTMLInputElement;
  let refundInput: HTMLInputElement;

  const generateStep: WizardStep = {
    id: "generate",
    title: "Generate swap",
    nextLabel: "Generate swap",
    render() {
      const body = el("div");

      nockAddrField = addressField({
        label: "Seller Nockchain Address",
        kind: "nock",
        initialValue: (() => {
          const sa = session.nock?.address;
          if (sa && isPlausibleWalletAddress(sa)) return sa;
          if (session.activeSwap) return session.activeSwap.sellerPkh;
          return "";
        })(),
      });

      const gift = field("NOCK Amount (nicks)", { type: "number", step: "1", min: "655360" });
      giftInput = gift.input;
      if (session.activeSwap) giftInput.value = session.activeSwap.nockGift.toString();

      const usdc = field("USDC amount (buyer pays)", { type: "number", step: "0.01", min: "0.01", value: "1.0" });
      usdcInput = usdc.input;
      if (session.activeSwap?.usdcAmount) usdcInput.value = session.activeSwap.usdcAmount;

      buyerNockField = addressField({
        label: "Buyer Nockchain Address (only this wallet can claim)",
        kind: "nock",
        initialValue: session.activeSwap?.buyerPkh ?? "",
      });

      const refund = field("Refund Block Height", { type: "number", step: "1", min: "1" });
      refundInput = refund.input;
      if (session.activeSwap) {
        refundInput.value = session.activeSwap.nockRefundHeight.toString();
      } else if (session.nock) {
        // Auto-populate with current block + 500 (~1 day at 2.5 min blocks).
        fetchCurrentBlockHeight(session.nock)
          .then((h) => {
            if (h != null && !refundInput.value) {
              refundInput.value = (h + 500n).toString();
            }
          })
          .catch(() => { /* leave blank — user can enter manually */ });
      }

      body.append(
        el("p", { class: "hint", text: "Your Base address is recorded automatically so the buyer never types it." }),
        nockAddrField.row, gift.row, usdc.row, buyerNockField.row, refund.row
      );
      return body;
    },
    async onNext() {
      const { swap, preimageJam, refundHeight } = await generateSwapAction({
        wallet: session.nock,
        buyerPkh: buyerNockField.getValue(),
        walletAddress: nockAddrField.getValue(),
        sellerEth: session.evm ?? "",
        usdcAmount: usdcInput.value,
        gift: giftInput.value,
        refundHeight: refundInput.value,
      });
      session.activeSwap = swap;
      session.activeRole = "seller";
      await secretStore.putSellerPreimage(swap.hEvm, preimageJam);
      await repo.put(swap);
      refundInput.value = refundHeight.toString();
      refreshShare();
      log(
        sharedLog,
        `Swap created. Swap ID: ${swap.hEvm}\nShare this ID with the buyer (preimage stays in this browser).`,
        true
      );
    },
  };

  // --- Step 2: lock NOCK ----------------------------------------------------
  let lockAddrField: ReturnType<typeof addressField>;
  const lockStep: WizardStep = {
    id: "lock-nock",
    title: "Lock NOCK on Nockchain",
    nextLabel: "Lock NOCK",
    render() {
      const body = el("div");
      lockAddrField = addressField({
        label: "Seller nockblocks wallet address (base58)",
        kind: "nock",
        initialValue: session.activeSwap?.sellerPkh ?? "",
      });
      body.append(
        lockAddrField.row,
        el("p", { class: "hint", text: "After locking, the swap carries lockFirstName so the buyer can claim." }),
        el("p", { class: "fee-disclaimer", text: "Fee: a 0.5% protocol fee is deducted from the USDC withdrawal." })
      );
      return body;
    },
    async onNext() {
      if (session.activeSwap?.lockFirstName) {
        log(sharedLog, "NOCK already locked for this swap.", true);
        return;
      }
      const { swap, result } = await lockNockAction({
        wallet: session.nock,
        swap: session.activeSwap,
        walletAddress: lockAddrField.getValue(),
      });
      session.activeSwap = swap;
      await repo.put(swap);
      refreshShare();
      const giftNock = Math.floor(Number(swap.nockGift) / 65536);
      log(sharedLog, `Locked ${giftNock} NOCK.\ntx: ${result.txId}\nlockFirstName: ${result.lockFirstName.slice(0, 12)}…`, true);
    },
  };

  // --- Step 3: withdraw USDC ------------------------------------------------
  const withdrawStep: WizardStep = {
    id: "withdraw-usdc",
    title: "Withdraw USDC",
    nextLabel: "Withdraw USDC (reveals preimage)",
    render() {
      const body = el("div");
      const s = session.activeSwap;
      body.append(
        el("p", { class: "hint", text: s?.buyerEth
          ? `Buyer locked ${s.usdcAmount ?? "?"} USDC. Withdraw reveals the preimage on Base; the buyer then claims NOCK.`
          : "Waiting for the buyer to lock USDC. Come back once they have." })
      );
      return body;
    },
    async onNext() {
      const { hash, swap } = await withdrawUsdcAction({ swap: session.activeSwap });
      session.activeSwap = swap;
      await persist();
      log(sharedLog, `USDC withdrawn — preimage public on Base.\ntx: ${hash}`, true);
    },
  };

  const doneStep: WizardStep = {
    id: "done",
    title: "Complete",
    terminal: true,
    render() {
      return el("div", {}, [el("p", { text: "Swap complete — USDC withdrawn and preimage revealed on Base." })]);
    },
  };

  // Steps: generate(0) → lock(1) → withdraw(2) → done(3)
  const steps = [generateStep, lockStep, withdrawStep, doneStep];

  let initialStep = 0;
  if (session.activeSwap) {
    const st = swapStatus(session.activeSwap);
    if (st === "withdrawn" || st === "claimed" || st === "refunded") initialStep = 3;
    else if (st === "nock-locked" || st === "usdc-locked") initialStep = 2;
    else initialStep = 1;
  }

  container.append(heading, wizardRoot, sharedLog, el("label", { text: "Swap ID (share with buyer)" }), shareArea);
  mountWizard(wizardRoot, steps, { onError: (e) => logErr(sharedLog, e), initialStep });
}
