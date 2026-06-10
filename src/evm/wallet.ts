import type { Address } from "viem";
import { connectWallet } from "./htlc.js";
import { selectWallet } from "./providers.js";

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