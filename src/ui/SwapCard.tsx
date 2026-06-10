/** Click-to-copy swap summary card (React port of swap-card.ts). */
import { useState } from "react";
import type { SwapPublic } from "../swap.js";
import { short, formatNock, copyText, quoteDisplay, useResolvedNock } from "./util.js";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="swap-card-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/** A party row whose value reverse-resolves to a .nock name when available. */
function PartyRow({ k, address }: { k: string; address?: string }) {
  const { text, title } = useResolvedNock(address, short(address));
  return (
    <div className="swap-card-row">
      <span className="k">{k}</span>
      <span className="v" title={title}>
        {text}
      </span>
    </div>
  );
}

export function SwapCard({ swap, json }: { swap: SwapPublic; json: string }) {
  const [copyLabel, setCopyLabel] = useState("Copy JSON");
  const [copied, setCopied] = useState(false);
  const quote = quoteDisplay(swap);

  async function onCopy() {
    const ok = await copyText(json);
    setCopyLabel(ok ? "Copied!" : "Copy failed");
    if (ok) setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setCopyLabel("Copy JSON");
    }, 1500);
  }

  return (
    <div
      className={"swap-card" + (copied ? " copied" : "")}
      title="Click to copy full swap JSON"
      onClick={onCopy}
    >
      <div className="swap-card-title">
        <span>Swap</span>
        <span className="swap-card-copy">{copyLabel}</span>
      </div>
      <Row k="Hashlock" v={short(swap.hEvm)} />
      <PartyRow k="Seller" address={swap.sellerPkh} />
      <PartyRow k="Buyer" address={swap.buyerPkh} />
      <Row k="Amount" v={formatNock(swap.nockGift ?? 0n)} />
      {swap.usdcAmount && <Row k="For" v={quote.amountLabel} />}
      <Row k="Refund height" v={(swap.nockRefundHeight ?? 0n).toString()} />
      {swap.lockFirstName && <Row k="Claim name" v={short(swap.lockFirstName)} />}
      {swap.nockLockTxId && <Row k="NOCK lock tx" v={short(swap.nockLockTxId)} />}
      {swap.usdcLockTxHash && (
        <Row k={`${quote.symbol} lock tx`} v={short(swap.usdcLockTxHash)} />
      )}
    </div>
  );
}

/** Swap card plus a collapsible raw-JSON view. */
export function SwapShare({ swap, json }: { swap: SwapPublic; json: string }) {
  return (
    <>
      <SwapCard swap={swap} json={json} />
      <details className="swap-raw">
        <summary>Show raw swap JSON</summary>
        <textarea readOnly value={json} />
      </details>
    </>
  );
}
