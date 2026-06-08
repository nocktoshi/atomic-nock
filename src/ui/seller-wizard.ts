import type { SwapSession } from "../app/state.js";
import {
  generateSwapAction,
  lockNockAction,
  withdrawUsdcAction,
} from "../actions/seller.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { secretStore } from "../app/storage/secret-store.js";
import { swapStatus } from "../app/roles.js";
import { connectIrisWallet, waitForIrisWallet } from "../nock/wallet.js";
import { connectEvmWallet } from "../evm/wallet.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";
import { fetchCurrentBlockHeight } from "../nock/balance.js";
import { el, field, runBusy } from "./dom.js";
import { addressField } from "./address-field.js";
import { mountWizard, type WizardStep } from "./wizard.js";
import { log, logErr, setWalletStatus } from "./log.js";
import { swapShare } from "./swap-card.js";

/** Build the seller (NOCK → USDC) wizard. Operates on session.activeSwap. */
export function buildSellerWizard(container: HTMLElement, session: SwapSession): void {
  const repo = getSwapRepository();
  const heading = el("h2", { class: "flow-title", text: "Seller (NOCK → USDC)" });
  const wizardRoot = el("div");
  const shareArea = el("div");
  const sharedLog = el("div", { class: "log", text: "Connect wallets to start." });

  const persist = () => (session.activeSwap ? repo.put(session.activeSwap) : Promise.resolve());

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

  // --- Step 1: connect Iris + MetaMask -------------------------------------
  const connectStep: WizardStep = {
    id: "connect",
    title: "Connect wallets",
    canAdvance() {
      return !!(session.nock && session.evm);
    },
    render(ctx) {
      const body = el("div");
      const irisStatus = el("span", { class: "wallet-status", text: "Iris: not connected" });
      const evmStatus = el("span", { class: "wallet-status", text: "MetaMask: not connected" });
      if (session.nock) setWalletStatus(irisStatus, "iris", true, session.nock.pkh.slice(0, 16) + "…");
      if (session.evm) setWalletStatus(evmStatus, "evm", true, session.evm);

      const proceed = () => {
        if (session.nock && session.evm) ctx.advance();
        else ctx.rerender();
      };

      const irisBtn = el("button", { type: "button", text: "Connect Iris" });
      irisBtn.onclick = () =>
        runBusy(irisBtn, async () => {
          session.nock = await connectIrisWallet();
          log(sharedLog, `Iris connected.\npkh: ${session.nock.pkh}`, true);
          proceed();
        }).catch((e) => logErr(sharedLog, e));

      const evmBtn = el("button", { type: "button", text: "Connect MetaMask" });
      evmBtn.onclick = () =>
        runBusy(evmBtn, async () => {
          session.evm = await connectEvmWallet();
          log(sharedLog, `MetaMask: ${session.evm}`, true);
          proceed();
        }).catch((e) => logErr(sharedLog, e));

      waitForIrisWallet(1500)
        .then(() => { if (!session.nock) irisStatus.textContent = "Iris: extension detected (click Connect)"; })
        .catch(() => { irisStatus.textContent = "Iris: install extension"; });

      body.append(
        el("div", { class: "wallet-row" }, [irisBtn, irisStatus]),
        el("div", { class: "wallet-row" }, [evmBtn, evmStatus]),
        el("p", { class: "hint", text: "Connect both wallets to continue." })
      );
      return body;
    },
  };

  // --- Step 2: generate swap ------------------------------------------------
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
      } else {
        // Attempt to auto-populate with current block + 500.
        if (session.nock) {
          fetchCurrentBlockHeight(session.nock)
            .then((h) => {
              if (h != null && !refundInput.value) {
                refundInput.value = (h + 500n).toString();
              }
            })
            .catch(() => { /* leave blank */ });
        }
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

  // --- Step 3: lock NOCK ----------------------------------------------------
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
        el("p", { class: "fee-disclaimer", text: "Fee: a 0.5% protocol fee is deducted from your USDC when you withdraw. You receive 99.5% of the locked USDC." })
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

  // --- Step 4: withdraw USDC ------------------------------------------------
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

  const steps = [connectStep, generateStep, lockStep, withdrawStep, doneStep];
  // Resume at the right step based on persisted status.
  let initialStep = session.nock && session.evm ? 1 : 0;
  if (session.activeSwap) {
    const st = swapStatus(session.activeSwap);
    if (st === "withdrawn" || st === "claimed" || st === "refunded") initialStep = 4;
    else if (st === "nock-locked" || st === "usdc-locked") initialStep = 3;
    else initialStep = 2;
    if (!session.nock || !session.evm) initialStep = 0;
  }

  container.append(heading, wizardRoot, sharedLog, el("label", { text: "Swap ID (share with buyer)" }), shareArea);
  mountWizard(wizardRoot, steps, { onError: (e) => logErr(sharedLog, e), initialStep });
}
