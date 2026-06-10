/** Dashboard swap card with status badges and Open / Refund / Hide actions. */
import type { SwapPublic } from "../swap.js";
import type { Role, SwapStage, RefundInfo } from "../app/roles.js";
import { impliedNockUsd } from "../market/price.js";
import { quoteDisplay, short, useResolvedNock } from "./util.js";

const NICKS_PER_NOCK = 65536;

function nock(swap: SwapPublic): string {
  return `${parseFloat((Number(swap.nockGift) / NICKS_PER_NOCK).toFixed(6))} NOCK`;
}

/** Stage badge text; quote-leg stages take the swap's token symbol. */
function stageLabel(status: SwapStage, symbol: string): string {
  const labels: Record<SwapStage, string> = {
    created: "Created",
    "nock-locked": "NOCK locked",
    "usdc-locked": `${symbol} locked`,
    withdrawn: `${symbol} withdrawn`,
    claimed: "Claimed",
    refunded: "Refunded",
  };
  return labels[status];
}

export interface OverviewCardProps {
  swap: SwapPublic;
  role: Role;
  status: SwapStage;
  refund: RefundInfo;
  onOpen(): void;
  onRefund(): void;
  onHide(): void;
  /** Seller-only: cancel an unclaimed open swap (delists it everywhere). */
  onCancel?(): void;
}

export function SwapOverviewCard({
  swap,
  role,
  status,
  refund,
  onOpen,
  onRefund,
  onHide,
  onCancel,
}: OverviewCardProps) {
  const refundable = role === "buyer" ? refund.eth : refund.nock;
  const quote = quoteDisplay(swap);
  // "$X/NOCK implied" only makes sense for a USD quote; wNOCK shows the ratio.
  const implied = quote.kind === "usd" ? impliedNockUsd(swap) : null;

  const counterparty = role === "seller" ? swap.buyerPkh : swap.sellerPkh;
  const counterLabel = role === "seller" ? "Buyer" : "Seller";
  const counter = useResolvedNock(counterparty, short(counterparty, 6, 4));

  return (
    <div className={"swap-card overview" + (refundable ? " refundable" : "")}>
      <button
        type="button"
        className="card-dismiss"
        title="Hide this swap (local only — does not delete it)"
        onClick={(e) => {
          e.stopPropagation();
          onHide();
        }}
      >
        ×
      </button>

      <div className="swap-card-title">
        <span>{role === "seller" ? "Selling NOCK" : "Buying NOCK"}</span>
        <div className="swap-card-title-badges">
          <span className="swap-badge">{stageLabel(status, quote.symbol)}</span>
          {refundable && <span className="refund-badge">Refund available</span>}
        </div>
      </div>

      <div>
        <div className="swap-card-row">
          <span className="k">Swap ID</span>
          <span className="v">{short(swap.hEvm, 8, 6)}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">NOCK</span>
          <span className="v">{nock(swap)}</span>
        </div>
        <div className="swap-card-row">
          <span className="k">{quote.symbol}</span>
          <span className="v">{quote.amountLabel}</span>
        </div>
        {implied != null ? (
          <div className="swap-card-row">
            <span className="k">Implied</span>
            <span className="v">{`$${implied.toFixed(4)}/NOCK`}</span>
          </div>
        ) : (
          quote.priceLabel && (
            <div className="swap-card-row">
              <span className="k">Price</span>
              <span className="v">{quote.priceLabel}</span>
            </div>
          )
        )}
        <div className="swap-card-row">
          <span className="k">{counterLabel}</span>
          <span className="v" title={counter.title}>
            {counter.text}
          </span>
        </div>
      </div>

      <div className="card-actions">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          Open
        </button>
        {refundable && (
          <button
            type="button"
            className="refund-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRefund();
            }}
          >
            {role === "buyer" ? `Refund ${quote.symbol}` : "Refund NOCK"}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            title="Remove this open order (nothing is locked yet)"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel order
          </button>
        )}
      </div>
    </div>
  );
}
