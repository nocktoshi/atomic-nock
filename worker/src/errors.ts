/** Leaf module so the Market DO, its client, and routes share one error type
 *  without import cycles. Re-exported from swaps.ts for existing importers. */
export class SwapError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
