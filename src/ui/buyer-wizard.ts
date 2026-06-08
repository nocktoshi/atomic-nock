import type { Hex } from "viem";
import type { SwapSession } from "../app/state.js";
import {
  lockUsdcAction,
  resolvePreimage,
  claimNockAction,
} from "../actions/buyer.js";
import { getSwapRepository } from "../app/repo/swap-repo.js";
import { swapStatus } from "../app/roles.js";
import { el, field } from "./dom.js";
import { addressField } from "./address-field.js";
import { mountWizard, type WizardStep } from "./wizard.js";
import { log, logErr } from "./log.js";
import { swapCard } from "./swap-card.js";

/** Build the buyer (USDC → NOCK) wizard. Wallets are already connected via the dashboard. */
export function buildBuyerWizard(container: HTMLElement, session: SwapSession): void {
  const repo = getSwapRepository();
  const heading = el("h2", { class: "flow-title", text: "Buyer (USDC → NOCK)" });
  const sharedLog = el("div", { class: "log", text: "" });
  const wizardRoot = el("div");
  const shareArea = el("div");

  // Show wallet status in the log on entry.
  const irisLabel = session.nock ? `Iris: ${session.nock.pkh.slice(0, 16)}…` : "Iris: not connected";
  const evmLabel = session.evm ? `MetaMask: ${session.evm}` : "MetaMask: not connected";
  log(sharedLog, `${irisLabel}\n${evmLabel}`, true);

  function refreshShare(): void {
    if (session.activeSwap) {
      shareArea.replaceChildren(swapCard(session.activeSwap, JSON.stringify({ swapId: session.activeSwap.hEvm })));
    }
  }
  refreshShare();

  async function ensurePreimage(withdrawTx: Hex | ""): Promise<Uint8Array> {
    if (session.buyerPreimageJam) return session.buyerPreimageJam;
    if (!session.activeSwap) throw new Error("No swap selected");
    const { preimageJam } = await resolvePreimage({
      swap: session.activeSwap,
      cached: session.buyerPreimageJam,
      withdrawTx,
      swapId: session.evmSwapId,
    });
    session.buyerPreimageJam = preimageJam;
    return preimageJam;
  }

  // --- Step 1: lock USDC ----------------------------------------------------
  const lockStep: WizardStep = {
    id: "lock-usdc",
    title: "Lock USDC",
    nextLabel: "Lock USDC",
    render() {
      const body = el("div");
      const s = session.activeSwap;
      const seller = addressField({
        label: "Seller Ethereum address (from swap)",
        kind: "eth",
        initialValue: s?.sellerEth ?? "",
        readonly: true,
      });
      const usdc = field("USDC amount (from swap)", { readonly: true });
      usdc.input.value = s?.usdcAmount ?? "";
      body.append(
        el("p", { class: "hint", text: "These come from the swap — no need to enter them." }),
        seller.row, usdc.row,
        el("p", { class: "fee-disclaimer", text: "Fee: a 0.5% protocol fee is paid by the seller (deducted from their USDC withdrawal). You lock and receive exactly the amounts shown." })
      );
      return body;
    },
    async onNext() {
      if (!session.activeSwap) throw new Error("No swap selected");
      const { swapId, lockTxHash, swap } = await lockUsdcAction({ swap: session.activeSwap });
      session.activeSwap = swap;
      session.evmSwapId = swapId;
      await repo.put(swap);
      refreshShare();
      log(sharedLog, `USDC locked.\nswapId: ${swapId}\ntx: ${lockTxHash}`, true);
    },
  };

  // --- Step 2: load preimage ------------------------------------------------
  let withdrawTxInput: HTMLInputElement;
  let autoLoadTried = false;
  const preimageStep: WizardStep = {
    id: "load-preimage",
    title: "Load preimage from Base",
    nextLabel: "Load preimage",
    render(ctx) {
      const body = el("div");
      const hasWithdraw = !!session.activeSwap?.usdcWithdrawTxHash;
      const status = el("p", {
        class: "preimage-status",
        text: session.buyerPreimageJam
          ? `Preimage ready (${session.buyerPreimageJam.length} bytes).`
          : hasWithdraw
            ? "Seller has withdrawn — loading the preimage from Base automatically…"
            : "After the seller withdraws USDC, the preimage loads from Base automatically.",
      });
      if (session.buyerPreimageJam) status.classList.add("ok");
      const tx = field("Seller withdraw tx (optional — only if auto-load fails)", {
        pattern: "^0x[0-9a-fA-F]{64}$",
        placeholder: "0x… from seller after USDC withdraw",
      });
      withdrawTxInput = tx.input;
      body.append(status, tx.row);

      if (!session.buyerPreimageJam && hasWithdraw && !autoLoadTried) {
        autoLoadTried = true;
        ensurePreimage("")
          .then(() => {
            log(sharedLog, "Preimage loaded automatically from Base.", true);
            ctx.rerender();
          })
          .catch((e) => logErr(sharedLog, e));
      }
      return body;
    },
    async onNext() {
      const jam = await ensurePreimage(withdrawTxInput.value.trim() as Hex | "");
      log(sharedLog, `Preimage verified against hNock.\nLength: ${jam.length} bytes.`, true);
    },
  };

  // --- Step 3: claim --------------------------------------------------------
  const claimStep: WizardStep = {
    id: "claim",
    title: "Claim NOCK",
    nextLabel: "Claim NOCK",
    render(ctx) {
      const body = el("div");
      const s = session.activeSwap;
      const preimageReady = !!session.buyerPreimageJam;
      const hasWithdraw = !!s?.usdcWithdrawTxHash;
      body.append(
        el("p", { class: "hint", text: s?.lockFirstName
          ? "Ready to claim the locked NOCK with the revealed preimage."
          : "Waiting for the seller to lock NOCK (lockFirstName not set yet)." }),
        el("p", {
          class: preimageReady ? "preimage-status ok" : "preimage-status",
          text: preimageReady
            ? `Preimage ready (${session.buyerPreimageJam!.length} bytes).`
            : hasWithdraw
              ? "Loading preimage from Base automatically…"
              : "Preimage will load once the seller withdraws USDC on Base.",
        })
      );

      if (!preimageReady && hasWithdraw && !autoLoadTried) {
        autoLoadTried = true;
        ensurePreimage("")
          .then(() => {
            log(sharedLog, "Preimage loaded automatically from Base.", true);
            ctx.rerender();
          })
          .catch((e) => logErr(sharedLog, e));
      }
      return body;
    },
    async onNext() {
      if (!session.activeSwap) throw new Error("No swap selected");
      const preimageJam = await ensurePreimage((withdrawTxInput?.value.trim() ?? "") as Hex | "");
      const { txId, swap } = await claimNockAction({
        wallet: session.nock,
        swap: session.activeSwap,
        preimageJam,
        lockFirstName: session.activeSwap.lockFirstName ?? "",
        gift: session.activeSwap.nockGift.toString(),
      });
      session.activeSwap = swap;
      await repo.put(swap);
      log(sharedLog, `NOCK claimed (Iris signed).\nTransaction ID: ${txId}`, true);
    },
  };

  const doneStep: WizardStep = {
    id: "done",
    title: "Complete",
    terminal: true,
    render() {
      log(sharedLog, `Swap complete — NOCK claimed.`, true);
      return el("div", {}, [el("p", { text: "🎉🎉 Swap complete. 🎉🎉" })]);
    },
  };

  // Steps: lock(0) → preimage(1) → claim(2) → done(3)
  const steps = [lockStep, preimageStep, claimStep, doneStep];

  let initialStep = 0;
  if (session.activeSwap) {
    const st = swapStatus(session.activeSwap);
    if (st === "claimed" || st === "refunded") initialStep = 3;
    else if (st === "withdrawn") initialStep = 2;
    else if (st === "usdc-locked") initialStep = 1;
    else initialStep = 0;
  }

  container.append(heading, wizardRoot, sharedLog, shareArea);
  mountWizard(wizardRoot, steps, { onError: (e) => logErr(sharedLog, e), initialStep });
}
