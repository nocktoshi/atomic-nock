/**
 * Global wallet connect bar — renders into `.wallet-bar-wrap` above the content.
 * Connecting updates the shared session so the dashboard/wizards react.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from 'react-router-dom' 
import { connectIrisWallet } from "../nock/wallet.js";
import { connectEvmWallet, setEvmAddress, silentReconnect } from "../evm/wallet.js";
import { subscribeWallets, getWalletsSnapshot } from "../evm/providers.js";
import { createPriceProvider } from "../market/price.js";
import { reverseResolveNock, reverseResolveEns } from "./name-resolve.js";
import { useSession } from "./session.js";
import { truncAddr } from "./util.js";
import { setActiveWallet, clearSession, ensureSession } from "../app/auth.js";
import { KV_URL } from "../config.js";

const LS_EVM = "evm-address";
const LS_NOCK = "nock-pkh";

const IRIS_SVG = `<svg width="18" height="18" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M256.614 200.083C287.496 200.083 312.53 225.118 312.531 256C312.531 286.883 287.497 311.917 256.614 311.917C225.732 311.916 200.698 286.882 200.698 256C200.698 225.118 225.733 200.084 256.614 200.083Z" fill="#7bd332"/><path fill-rule="evenodd" clip-rule="evenodd" d="M332.427 0C374.975.002 409.465 34.494 409.468 77.042V101.896H434.323C476.876 101.896 511.364 136.405 511.364 178.958C511.361 221.475 476.931 255.945 434.427 256C476.931 256.054 511.381 290.525 511.385 333.042C511.385 375.594 476.875 410.104 434.323 410.104H409.468V434.958C409.463 477.506 374.975 511.998 332.427 512C293.204 512 260.817 482.682 255.989 444.771C251.162 482.68 218.793 511.997 179.573 512C137.022 512 102.515 477.507 102.51 434.958V410.104H77.656C35.107 410.1.615 375.591.614 333.042C.618 290.525 35.068 256.054 77.573 256C35.068 255.945.617 221.475.614 178.958C.614 136.408 35.107 101.901 77.656 101.896H102.51V77.042C102.514 34.492 137.022 0 179.573 0C218.789.003 251.157 29.305 255.989 67.208C260.821 29.302 293.208.0 332.427 0ZM304.573 187.083C275.444 167.238 237.138 167.237 208.01 187.083L121.593 245.979C114.356 250.912 114.355 261.588 121.593 266.521L208.01 325.396C237.14 345.245 275.443 345.244 304.573 325.396L390.989 266.521C398.228 261.588 398.228 250.912 390.989 245.979L304.573 187.083Z" fill="#7bd332"/></svg>`;

const ETH_SVG = `<svg version="1.2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
	<style>
		.s0 { fill: #627eea } 
		.s1 { opacity: .6;fill: #ffffff } 
		.s2 { fill: #ffffff } 
		.s3 { opacity: .2;fill: #ffffff } 
		.s4 { fill: #0000ff } 
	</style>
	<g>
		<path fill-rule="evenodd" class="s0" d="m8.25 16.13c-4.35 0-7.88-3.53-7.88-7.88 0-4.35 3.53-7.87 7.88-7.87 4.35 0 7.88 3.52 7.88 7.87 0 4.35-3.53 7.88-7.88 7.88z"/>
		<g>
			<path class="s1" d="m8.5 2.34v4.37l3.69 1.65z"/>
			<path class="s2" d="m8.5 2.34l-3.7 6.02 3.7-1.65z"/>
			<path class="s1" d="m8.5 11.19v2.96l3.69-5.1z"/>
			<path class="s2" d="m8.5 14.15v-2.96l-3.7-2.14z"/>
			<path class="s3" d="m8.5 10.5l3.69-2.14-3.69-1.65z"/>
			<path class="s1" d="m4.8 8.36l3.7 2.14v-3.79z"/>
		</g>
	</g>
	<g style="opacity: .34">
		<path class="s2" d="m9.11 9.81c0-0.24 0-0.36 0.05-0.45q0.06-0.14 0.2-0.2c0.09-0.05 0.21-0.05 0.45-0.05h7.38c0.24 0 0.36 0 0.45 0.05q0.14 0.06 0.2 0.2c0.05 0.09 0.05 0.21 0.05 0.45v7.38c0 0.24 0 0.36-0.05 0.45q-0.06 0.14-0.2 0.2c-0.09 0.05-0.21 0.05-0.45 0.05h-7.38c-0.24 0-0.36 0-0.45-0.05q-0.14-0.06-0.2-0.2c-0.05-0.09-0.05-0.21-0.05-0.45 0 0 0-7.38 0-7.38z"/>
	</g>
	<g>
		<path class="s4" d="m9.64 10.25c0-0.21 0-0.32 0.04-0.4q0.06-0.11 0.17-0.17c0.08-0.04 0.19-0.04 0.4-0.04h6.5c0.21 0 0.32 0 0.4 0.04q0.11 0.06 0.17 0.17c0.04 0.08 0.04 0.19 0.04 0.4v6.5c0 0.21 0 0.32-0.04 0.4q-0.06 0.11-0.17 0.17c-0.08 0.04-0.19 0.04-0.4 0.04h-6.5c-0.21 0-0.32 0-0.4-0.04q-0.11-0.06-0.17-0.17c-0.04-0.08-0.04-0.19-0.04-0.4 0 0 0-6.5 0-6.5z"/>
	</g>
</svg>`;

const price = createPriceProvider();

function WalletBtn({
  iconSvg,
  label,
  address,
  busy,
  onClick,
  onDisconnect,
}: {
  iconSvg: string;
  label: string;
  address: string | null;
  busy: boolean;
  onClick(): void;
  onDisconnect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const btn = (
    <button
      type="button"
      className={
        "wallet-connect-btn" +
        (address ? " connected" : "") +
        (busy ? " busy" : "")
      }
      disabled={busy}
      onClick={address && onDisconnect ? () => setOpen((o) => !o) : onClick}
    >
      <span
        className="wallet-btn-icon"
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
      <span className="wallet-btn-label">{address ? truncAddr(address) : label}</span>
      {address && onDisconnect && <span className="wallet-btn-chevron">▾</span>}
    </button>
  );

  if (!address || !onDisconnect) return btn;

  return (
    <div className="wallet-picker">
      {btn}
      {open && (
        <>
          <div className="wallet-backdrop" onClick={() => setOpen(false)} />
          <div className="wallet-menu">

          <button
              type="button"
              className="wallet-menu-item"
              onClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
            >
              Settings
            </button>
            <button
              type="button"
              className="wallet-menu-item"
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Base wallet connect. When connected shows address + chevron + disconnect.
 * When disconnected with 2+ wallets discovered (EIP-6963), opens a picker.
 */
function EvmConnect({
  address,
  busy,
  onConnect,
  onDisconnect,
}: {
  address: string | null;
  busy: boolean;
  onConnect(rdns?: string): void;
  onDisconnect(): void;
}) {
  const wallets = useSyncExternalStore(subscribeWallets, getWalletsSnapshot);
  const [open, setOpen] = useState(false);

  if (address) {
    return (
      <WalletBtn
        iconSvg={ETH_SVG}
        label="Base"
        address={address}
        busy={busy}
        onClick={() => {}}
        onDisconnect={onDisconnect}
      />
    );
  }

  if (wallets.length <= 1) {
    return (
      <WalletBtn
        iconSvg={ETH_SVG}
        label="Base"
        address={null}
        busy={busy}
        onClick={() => onConnect(wallets[0]?.info.rdns)}
      />
    );
  }

  return (
    <div className="wallet-picker">
      <WalletBtn
        iconSvg={ETH_SVG}
        label="Base"
        address={null}
        busy={busy}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <>
          <div className="wallet-backdrop" onClick={() => setOpen(false)} />
          <div className="wallet-menu">
            {wallets.map((w) => (
              <button
                key={w.info.rdns}
                type="button"
                className="wallet-menu-item"
                onClick={() => {
                  setOpen(false);
                  onConnect(w.info.rdns);
                }}
              >
                <img src={w.info.icon} alt="" width={18} height={18} />
                {w.info.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function WalletBar() {
  const { nock, evm, setNock, setEvm } = useSession();
  const [irisName, setIrisName] = useState<string | null>(null);
  const [irisNameFor, setIrisNameFor] = useState<string | undefined>(undefined);
  const [evmName, setEvmName] = useState<string | null>(null);
  const [evmNameFor, setEvmNameFor] = useState<string | undefined>(undefined);
  const [irisBusy, setIrisBusy] = useState(false);
  const [evmBusy, setEvmBusy] = useState(false);
  const [priceText, setPriceText] = useState("");

  useEffect(() => {
    void price.getNockUsd().then((usd) => {
      setPriceText(usd != null ? `$NOCK ≈ $${usd.toFixed(4)} USD` : "");
    });
  }, []);

  // Auto-reconnect on page load if a previous session was saved.
  useEffect(() => {
    // EVM: eth_accounts is silent — no popup, returns empty if wallet is locked/gone.
    // Delay slightly so EIP-6963 wallets have time to announce themselves.
    if (localStorage.getItem(LS_EVM)) {
      const t = setTimeout(() => {
        void silentReconnect().then((addr) => {
          if (addr) setEvm(addr);
          else localStorage.removeItem(LS_EVM);
        }).catch(() => localStorage.removeItem(LS_EVM));
      }, 200);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Iris: nock_connect is idempotent — the extension returns the stored pkh without
    // a popup if the user already approved this origin.
    if (localStorage.getItem(LS_NOCK)) {
      void connectIrisWallet().then((session) => {
        setNock(session);
        if (KV_URL) {
          setActiveWallet(session);
          void ensureSession(KV_URL).catch(() => {});
        }
      }).catch(() => {
        // Extension locked or unavailable — leave the key so the user can retry manually.
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the connected Iris wallet with the auth layer so the write path can
  // sign in (server sessions are bound to this wallet's pkh).
  useEffect(() => {
    setActiveWallet(nock);
  }, [nock]);

  // Reverse-resolve connected wallets for friendly button labels.
  const irisPkh = nock?.pkh;
  useEffect(() => {
    if (!irisPkh) return;
    let alive = true;
    reverseResolveNock(irisPkh)
      .then((n) => {
        if (!alive) return;
        setIrisNameFor(irisPkh);
        setIrisName(n !== irisPkh ? n : null);
      })
      .catch(() => { });
    return () => {
      alive = false;
    };
  }, [irisPkh]);

  useEffect(() => {
    if (!evm) return;
    let alive = true;
    reverseResolveEns(evm)
      .then((n) => {
        if (!alive) return;
        setEvmNameFor(evm);
        setEvmName(n !== evm ? n : null);
      })
      .catch(() => { });
    return () => {
      alive = false;
    };
  }, [evm]);

  async function connectIris() {
    if (irisBusy) return;
    setIrisBusy(true);
    try {
      const session = await connectIrisWallet();
      setNock(session);
      localStorage.setItem(LS_NOCK, session.pkh);
      // Sign in up front (one popup at connect), so writes don't prompt mid-action.
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

  function disconnectIris() {
    setNock(null);
    setActiveWallet(null);
    clearSession(nock?.pkh);
    localStorage.removeItem(LS_NOCK);
  }

  async function connectEvm(rdns?: string) {
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

  function disconnectEvm() {
    setEvm(null);
    setEvmAddress(null);
    localStorage.removeItem(LS_EVM);
  }

  return (
    <>
      <WalletBtn
        iconSvg={IRIS_SVG}
        label="Nockchain"
        address={
          irisNameFor === irisPkh && irisName
            ? irisName
            : nock?.pkh ?? null
        }
        busy={irisBusy}
        onClick={connectIris}
        onDisconnect={disconnectIris}
      />
      <EvmConnect
        address={evmNameFor === evm && evmName ? evmName : evm ?? null}
        busy={evmBusy}
        onConnect={connectEvm}
        onDisconnect={disconnectEvm}
      />
      <div className="price-banner">{priceText}</div>
    </>
  );
}
