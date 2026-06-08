import type { Address } from "viem";
import { connectWallet } from "./htlc.js";

let connected: Address | null = null;

export async function connectEvmWallet(): Promise<Address> {
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