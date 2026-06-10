/**
 * EIP-6963 multi-wallet discovery. A browser can have several injected wallets
 * (MetaMask, Rabby, Coinbase, …) but `window.ethereum` only exposes whichever
 * one won the injection race. EIP-6963 lets each wallet announce itself, so the
 * user can choose which to connect — this module is the single source of truth
 * for "the active EIP-1193 provider" that the rest of evm/ talks to.
 */
import type { EIP1193Provider } from "viem";

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data-URI
  rdns: string; // stable id, e.g. "io.metamask"
}
export interface DiscoveredWallet {
  info: WalletInfo;
  provider: EIP1193Provider;
}

const RDNS_KEY = "evm-wallet-rdns";
const wallets = new Map<string, DiscoveredWallet>(); // keyed by rdns
const listeners = new Set<() => void>();
let snapshot: DiscoveredWallet[] = [];
let selectedRdns =
  typeof window !== "undefined" ? localStorage.getItem(RDNS_KEY) : null;

function publish(): void {
  snapshot = [...wallets.values()];
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const { info, provider } = (e as CustomEvent<DiscoveredWallet>).detail;
    if (info?.rdns && !wallets.has(info.rdns)) {
      wallets.set(info.rdns, { info, provider });
      publish();
    }
  });
  // Ask any installed wallets to announce themselves.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** useSyncExternalStore subscribe — re-renders the picker as wallets announce. */
export function subscribeWallets(cb: () => void): () => void {
  listeners.add(cb);
  window.dispatchEvent(new Event("eip6963:requestProvider")); // catch late wallets
  return () => listeners.delete(cb);
}

/** Stable snapshot (same ref until a new wallet appears) for useSyncExternalStore. */
export function getWalletsSnapshot(): DiscoveredWallet[] {
  return snapshot;
}

/** Remember the user's pick so reconnects use the same wallet. */
export function selectWallet(rdns: string): void {
  selectedRdns = rdns;
  localStorage.setItem(RDNS_KEY, rdns);
}

/** The active provider: user-picked → first discovered → legacy window.ethereum. */
export function getProvider(): EIP1193Provider {
  if (selectedRdns && wallets.has(selectedRdns)) {
    return wallets.get(selectedRdns)!.provider;
  }
  if (snapshot[0]) return snapshot[0].provider;
  const legacy = (window as Window & { ethereum?: object }).ethereum;
  if (legacy) return legacy as EIP1193Provider;
  throw new Error(
    "No Ethereum wallet found — install MetaMask, Rabby, or another Base wallet"
  );
}
