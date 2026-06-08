import type { SwapPublic } from "../swap.js";
import type { Role, SwapStage, RefundInfo } from "../app/roles.js";
import { impliedNockUsd } from "../market/price.js";
import { el } from "./dom.js";

const NICKS_PER_NOCK = 65536;

function short(s: string | undefined, head = 6, tail = 4): string {
  if (!s) return "—";
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function nock(swap: SwapPublic): string {
  return `${parseFloat((Number(swap.nockGift) / NICKS_PER_NOCK).toFixed(6))} NOCK`;
}

const STAGE_LABEL: Record<SwapStage, string> = {
  created: "Created",
  "nock-locked": "NOCK locked",
  "usdc-locked": "USDC locked",
  withdrawn: "USDC withdrawn",
  claimed: "Claimed",
  refunded: "Refunded",
};

export interface OverviewCardOpts {
  swap: SwapPublic;
  role: Role;
  status: SwapStage;
  refund: RefundInfo;
  onOpen(): void;
  onRefund(): void;
  /** Soft-delete: hide this card locally (no server calls). */
  onHide(): void;
}

/** A dashboard row summarizing one swap, with resume + refund affordances. */
export function swapOverviewCard(opts: OverviewCardOpts): HTMLElement {
  const { swap, role, status, refund } = opts;
  const refundable = role === "buyer" ? refund.eth : refund.nock;
  const implied = impliedNockUsd(swap);

  const card = el("div", { class: "swap-card overview" });

  // Dismiss button absolutely positioned in the upper-right corner of the card.
  const dismiss = el("button", {
    type: "button",
    class: "card-dismiss",
    text: "×",
  });
  dismiss.title = "Hide this swap (local only — does not delete it)";
  dismiss.onclick = (e) => {
    e.stopPropagation();
    opts.onHide();
  };

  const title = el("div", { class: "swap-card-title" }, [
    el("span", { text: role === "seller" ? "Selling NOCK" : "Buying NOCK" }),
    el("div", { class: "swap-card-title-badges" }, [
      el("span", { class: "swap-badge", text: STAGE_LABEL[status] }),
      ...(refundable ? [el("span", { class: "refund-badge", text: "Refund available" })] : []),
    ]),
  ]);

  const rows = el("div");
  const row = (k: string, v: string) =>
    el("div", { class: "swap-card-row" }, [
      el("span", { class: "k", text: k }),
      el("span", { class: "v", text: v }),
    ]);
  rows.append(
    row("Swap ID", short(swap.hEvm, 8, 6)),
    row("NOCK", nock(swap)),
    row("USDC", swap.usdcAmount ? `${swap.usdcAmount} USDC` : "—"),
    ...(implied != null ? [row("Implied", `$${implied.toFixed(4)}/NOCK`)] : [])
  );

  const actions = el("div", { class: "card-actions" });
  const open = el("button", { type: "button", text: "Open" });
  open.onclick = (e) => {
    e.stopPropagation();
    opts.onOpen();
  };
  actions.append(open);

  if (refundable) {
    card.classList.add("refundable");
    const refundBtn = el("button", {
      type: "button",
      class: "refund-btn",
      text: role === "buyer" ? "Refund USDC" : "Refund NOCK",
    });
    refundBtn.onclick = (e) => {
      e.stopPropagation();
      opts.onRefund();
    };
    actions.append(refundBtn);
  }

  card.append(dismiss, title, rows, actions);
  return card;
}
