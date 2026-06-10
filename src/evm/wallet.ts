import type { Address } from "viem";
import { connectWallet } from "./htlc.js";
import { getProvider, selectWallet } from "./providers.js";

let connected: Address | null = null;

/** Connect a Base wallet. Pass an EIP-6963 `rdns` to choose a specific wallet. */
export async function connectEvmWallet(rdns?: string): Promise<Address> {
  if (rdns) selectWallet(rdns);
  connected = await connectWallet();
  return connected;
}

export function getEvmAddress(): Address | null {
  return connected;
}

export function requireEvmAddress(): Address {
  if (!connected) {
    throw new Error("Connect MetaMask on Base first");
  }
  return connected;
}

export function setEvmAddress(addr: Address | null): void {
  connected = addr;
}

/** Restore EVM connection silently (no popup) using eth_accounts. */
export async function silentReconnect(): Promise<Address | null> {
  try {
    const accounts = (await getProvider().request({ method: "eth_accounts" })) as string[];
    if (accounts[0]) {
      connected = accounts[0] as Address;
      return connected;
    }
  } catch {
    // wallet unavailable or not connected
  }
  return null;
}