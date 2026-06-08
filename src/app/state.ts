import type { SwapPublic } from "../swap.js";
import type { Role } from "./roles.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { Address, Hex } from "viem";

/**
 * Session state for one browser. Multi-swap: the dashboard lists swaps from the
 * repository and sets `activeSwap` + `activeRole` when one is opened. Persistence
 * lives in the SwapRepository (KV) and SecretStore (IndexedDB), not here.
 */
export interface SwapSession {
  activeSwap: SwapPublic | null;
  activeRole: Role | null;
  /** EVM HTLC swapId for the active swap once computed at lock. */
  evmSwapId: Hex | null;
  /** Connected Iris (Nockchain) wallet. */
  nock: NockWalletSession | null;
  /** Connected Base address. */
  evm: Address | null;
  /** Buyer preimage cached in-memory for the active swap (re-derivable from chain). */
  buyerPreimageJam: Uint8Array | null;
}

export function createSession(): SwapSession {
  return {
    activeSwap: null,
    activeRole: null,
    evmSwapId: null,
    nock: null,
    evm: null,
    buyerPreimageJam: null,
  };
}
