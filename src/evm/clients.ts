/**
 * EVM client seam. The browser rides the injected EIP-1193 wallet (`custom(
 * getProvider())`) and the account is whatever the wallet has selected; the
 * solver daemon swaps in an `http(BASE_RPC)` transport + a local private-key
 * account via `setEvmClientFactory`. Every Base-leg function in htlc.ts /
 * preimage.ts pulls its clients from here, so they work unchanged in Node.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
} from "viem";
import { CHAIN } from "../config.js";
import { getProvider } from "./providers.js";

// Bind the client types to CHAIN so the Base OP-stack block/tx variants and the
// chain-aware writeContract overloads match what the call sites already expect.
function makeBrowserPublic() {
  return createPublicClient({ chain: CHAIN, transport: custom(getProvider()) });
}
function makeBrowserWallet() {
  return createWalletClient({ chain: CHAIN, transport: custom(getProvider()) });
}

export type EvmPublicClient = ReturnType<typeof makeBrowserPublic>;
export type EvmWalletClient = ReturnType<typeof makeBrowserWallet>;

export interface EvmClients {
  publicClient: EvmPublicClient;
  walletClient: EvmWalletClient;
  /** Address writes are sent from (async because the browser asks the wallet). */
  account(): Promise<Address>;
}

type Factory = () => EvmClients;

/** Default factory: injected EIP-1193 provider for both clients (browser). */
function browserFactory(): EvmClients {
  const publicClient = makeBrowserPublic();
  const walletClient = makeBrowserWallet();
  return {
    publicClient,
    walletClient,
    account: async () => {
      const [addr] = await walletClient.getAddresses();
      if (!addr) throw new Error("No Base account available from the wallet");
      return addr;
    },
  };
}

let factory: Factory = browserFactory;

/** Swap the client factory (solver daemon: http transport + local account). */
export function setEvmClientFactory(f: Factory): void {
  factory = f;
}

/** Fresh clients for one operation (cheap; matches the prior inline construction). */
export function getEvmClients(): EvmClients {
  return factory();
}
