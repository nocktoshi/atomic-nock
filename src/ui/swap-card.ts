import type { SwapPublic } from "../swap.js";
import { el } from "./dom.js";

const NICKS_PER_NOCK = 65536;

function short(s: string | undefined, head = 8, tail = 6): string {
  if (!s) return "—";
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function formatNock(nicks: bigint): string {
  const nock = Number(nicks) / NICKS_PER_NOCK;
  // Trim trailing zeros, keep up to 6 decimals.
  return `${parseFloat(nock.toFixed(6))} NOCK`;
}

/** Copy text to the clipboard, with a fallback for non-secure / restricted contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function row(k: string, v: string): HTMLElement {
  return el("div", { class: "swap-card-row" }, [
    el("span", { class: "k", text: k }),
    el("span", { class: "v", text: v }),
  ]);
}

/**
 * A compact, click-to-copy summary of a swap. Clicking the card (or its Copy
 * pill) copies the full swap JSON to the clipboard.
 */
export function swapCard(swap: SwapPublic, json: string): HTMLElement {
  const copyPill = el("span", { class: "swap-card-copy", text: "Copy JSON" });
  const card = el("div", { class: "swap-card" }, [
    el("div", { class: "swap-card-title" }, [
      el("span", { text: "Swap" }),
      copyPill,
    ]),
    row("Hashlock", short(swap.hEvm)),
    row("Seller", short(swap.sellerPkh)),
    row("Buyer", short(swap.buyerPkh)),
    row("Amount", formatNock(swap.nockGift)),
    row("Refund height", swap.nockRefundHeight.toString()),
    ...(swap.lockFirstName ? [row("Claim name", short(swap.lockFirstName))] : []),
    ...(swap.nockLockTxId ? [row("NOCK lock tx", short(swap.nockLockTxId))] : []),
    ...(swap.usdcLockTxHash ? [row("USDC lock tx", short(swap.usdcLockTxHash))] : []),
  ]);

  card.title = "Click to copy full swap JSON";
  card.onclick = async () => {
    const ok = await copyText(json);
    copyPill.textContent = ok ? "Copied!" : "Copy failed";
    if (ok) card.classList.add("copied");
    setTimeout(() => {
      card.classList.remove("copied");
      copyPill.textContent = "Copy JSON";
    }, 1500);
  };

  return card;
}

/**
 * Seller share block: the card plus a collapsible raw-JSON textarea (so the full
 * shareable string is still available for manual paste).
 */
export function swapShare(swap: SwapPublic, json: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const details = el("details", { class: "swap-raw" });
  const ta = el("textarea", { readonly: true });
  ta.value = json;
  details.append(el("summary", { text: "Show raw swap JSON" }), ta);
  frag.append(swapCard(swap, json), details);
  return frag;
}
