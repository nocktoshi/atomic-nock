/** Shared Iris + Base connect actions for inline connect buttons in swap flows. */
import { useState } from "react";
import { connectIrisWallet } from "../nock/wallet.js";
import { connectEvmWallet } from "../evm/wallet.js";
import { KV_URL } from "../config.js";
import { setActiveWallet, ensureSession } from "../app/auth.js";
import { useSession } from "./session.js";

const LS_EVM = "evm-address";
const LS_NOCK = "nock-pkh";

export function useWalletConnectActions() {
  const { nock, evm, setNock, setEvm } = useSession();
  const [irisBusy, setIrisBusy] = useState(false);
  const [evmBusy, setEvmBusy] = useState(false);

  async function connectIris(): Promise<void> {
    if (irisBusy) return;
    setIrisBusy(true);
    try {
      const session = await connectIrisWallet();
      setNock(session);
      localStorage.setItem(LS_NOCK, session.pkh);
      if (KV_URL) {
        setActiveWallet(session);
        try {
          await ensureSession(KV_URL);
        } catch (e) {
          console.error("Sign-in failed (will retry on first write):", e);
        }
      }
    } catch (e) {
      console.error("Iris connect failed:", e);
    } finally {
      setIrisBusy(false);
    }
  }

  async function connectEvm(rdns?: string): Promise<void> {
    if (evmBusy) return;
    setEvmBusy(true);
    try {
      const addr = await connectEvmWallet(rdns);
      setEvm(addr);
      localStorage.setItem(LS_EVM, addr);
    } catch (e) {
      console.error("Wallet connect failed:", e);
    } finally {
      setEvmBusy(false);
    }
  }

  return {
    nock,
    evm,
    irisBusy,
    evmBusy,
    connectBusy: irisBusy || evmBusy,
    connectIris,
    connectEvm,
  };
}