/**
 * 1Click client. Always calls OUR worker proxy (`/oneclick/*`), never 1Click
 * directly — the distribution-channel JWT (fee-free) and our appFees live
 * server-side. Used for the optional any-asset/any-chain hops that bracket a
 * NOCK swap; the core HTLC swap never touches 1Click.
 */
import { KV_URL } from "../config.js";

/** Base USDC — the hinge asset between 1Click and the HTLC marketplace. */
export const BASE_USDC_ASSET_ID =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "INCOMPLETE_DEPOSIT"
  | "FAILED";

export interface OneClickQuote {
  depositAddress: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  deadline: string;
  timeEstimate?: number;
}

export interface QuoteParams {
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  /** nep141 asset ids (see assets.ts). */
  originAsset: string;
  destinationAsset: string;
  /** Atomic units of the origin (EXACT_INPUT) or destination (EXACT_OUTPUT). */
  amount: string;
  /** Where the output lands (destination-chain address). */
  recipient: string;
  /** Where a failed deposit is refunded (origin-chain address). */
  refundTo: string;
  slippageToleranceBps?: number;
  deadlineSec?: number;
  /** dry = price only, no deposit address allocated. */
  dry?: boolean;
}

function base(): string {
  if (!KV_URL) throw new Error("1Click needs the worker — set VITE_KV_URL");
  return KV_URL.replace(/\/$/, "");
}

export async function getOneClickQuote(p: QuoteParams): Promise<OneClickQuote> {
  const body = {
    dry: p.dry ?? false,
    swapType: p.swapType,
    slippageTolerance: p.slippageToleranceBps ?? 100,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAsset,
    amount: p.amount,
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + (p.deadlineSec ?? 1800) * 1000).toISOString(),
  };
  const res = await fetch(`${base()}/oneclick/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { quote?: OneClickQuote; message?: string };
  if (!res.ok || !json.quote) {
    throw new Error(json.message || `1Click quote failed (${res.status})`);
  }
  return json.quote;
}

export interface OneClickStatusResult {
  status: OneClickStatus;
  updatedAt?: string;
  swapDetails?: {
    amountOut?: string | null;
    amountOutFormatted?: string | null;
    destinationChainTxHashes?: { hash: string }[] | string[];
    refundedAmountFormatted?: string | null;
    refundReason?: string | null;
  };
}

export async function getOneClickStatus(depositAddress: string): Promise<OneClickStatusResult> {
  const res = await fetch(
    `${base()}/oneclick/status?depositAddress=${encodeURIComponent(depositAddress)}`
  );
  if (!res.ok) throw new Error(`1Click status failed (${res.status})`);
  return (await res.json()) as OneClickStatusResult;
}

/** Tell 1Click which tx funded the deposit (speeds up detection; optional). */
export async function submitDepositTx(depositAddress: string, txHash: string): Promise<void> {
  await fetch(`${base()}/oneclick/deposit/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ depositAddress, txHash }),
  }).catch(() => {});
}

/** Terminal states for a 1Click hop. */
export function isTerminal(s: OneClickStatus): boolean {
  return s === "SUCCESS" || s === "REFUNDED" || s === "FAILED";
}
