/**
 * Client mirror of the Worker's per-party progress fields (worker/src/contract.ts).
 * Only these may be written via /swap/:id/advance, scoped to the signing party.
 */
export const SELLER_FIELDS = [
  "lockFirstName",
  "lockRoot",
  "parentHash",
  "birthOutputIndex",
  "nockLockTxId",
  "usdcWithdrawTxHash",
  "nockRefundTxId",
] as const;

export const BUYER_FIELDS = [
  "usdcLockTxHash",
  "nockClaimTxId",
  "usdcRefundTxHash",
] as const;

export type SwapRole = "seller" | "buyer";

/** Pick a party's progress fields out of an encoded swap object. */
export function progressFields(
  encoded: Record<string, unknown>,
  role: SwapRole
): Record<string, unknown> {
  const names = role === "seller" ? SELLER_FIELDS : BUYER_FIELDS;
  const out: Record<string, unknown> = {};
  for (const n of names) if (encoded[n] != null) out[n] = encoded[n];
  return out;
}
