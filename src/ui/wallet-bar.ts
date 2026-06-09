/**
 * Global wallet connect bar — mounted once at app start, fixed top-right.
 * Persists across dashboard ↔ wizard navigation.
 */
import type { SwapSession } from "../app/state.js";
import { connectIrisWallet } from "../nock/wallet.js";
import { connectEvmWallet } from "../evm/wallet.js";
import { reverseResolveNock, reverseResolveEns } from "./name-resolve.js";
import { runBusy } from "./dom.js";
import { logErr } from "./log.js";

const IRIS_SVG = `<svg width="18" height="18" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M256.614 200.083C287.496 200.083 312.53 225.118 312.531 256C312.531 286.883 287.497 311.917 256.614 311.917C225.732 311.916 200.698 286.882 200.698 256C200.698 225.118 225.733 200.084 256.614 200.083Z" fill="#7bd332"/><path fill-rule="evenodd" clip-rule="evenodd" d="M332.427 0C374.975.002 409.465 34.494 409.468 77.042V101.896H434.323C476.876 101.896 511.364 136.405 511.364 178.958C511.361 221.475 476.931 255.945 434.427 256C476.931 256.054 511.381 290.525 511.385 333.042C511.385 375.594 476.875 410.104 434.323 410.104H409.468V434.958C409.463 477.506 374.975 511.998 332.427 512C293.204 512 260.817 482.682 255.989 444.771C251.162 482.68 218.793 511.997 179.573 512C137.022 512 102.515 477.507 102.51 434.958V410.104H77.656C35.107 410.1.615 375.591.614 333.042C.618 290.525 35.068 256.054 77.573 256C35.068 255.945.617 221.475.614 178.958C.614 136.408 35.107 101.901 77.656 101.896H102.51V77.042C102.514 34.492 137.022 0 179.573 0C218.789.003 251.157 29.305 255.989 67.208C260.821 29.302 293.208.0 332.427 0ZM304.573 187.083C275.444 167.238 237.138 167.237 208.01 187.083L121.593 245.979C114.356 250.912 114.355 261.588 121.593 266.521L208.01 325.396C237.14 345.245 275.443 345.244 304.573 325.396L390.989 266.521C398.228 261.588 398.228 250.912 390.989 245.979L304.573 187.083Z" fill="#7bd332"/></svg>`;

const FOX_SVG = `<svg width="18" height="18" viewBox="0 0 318 318" xmlns="http://www.w3.org/2000/svg"><path d="M274.1 35.5l-99.7 74.1 18.4-43.6z" fill="#E2761B"/><path d="M44 35.5l98.9 74.8-17.5-44.3zm193.5 171.3l-26.5 40.6 56.7 15.6 16.3-55.3zm-204.4.9L49.8 263l56.7-15.6-26.5-40.6z" fill="#E4761B"/><path d="M103.5 138.7l-15.8 23.9 56.3 2.5-2-60.5zm111.1 0l-39.2-34.8-1.3 61.2 56.2-2.5zM106.5 247.4l33.8-16.5-29.2-22.8zm72.2-16.5l33.9 16.5-4.7-39.3z" fill="#E4761B"/><path d="M212.6 247.4l-33.9-16.5 2.7 22.1-.3 9.3zm-106.1 0l31.5 14.9-.2-9.3 2.5-22.1z" fill="#D7C1B3"/><path d="M138.8 193.5l-28.2-8.3 19.9-9.1zm40.6 0l8.3-17.4 20 9.1z" fill="#233447"/><path d="M106.5 247.4l4.8-40.6-31.3.9zM207 206.8l4.8 40.6 26.5-39.7zm23.8-44.2l-56.2 2.5 5.2 28.4 8.3-17.4 20 9.1zm-120.3 22.6l20-9.1 8.2 17.4 5.3-28.4-56.3-2.5z" fill="#CD6116"/><path d="M82.4 162.6l23.6 46-.8-22.9zm130.5 23.1l-1 22.9 23.7-46zm-74.2-20.6l-5.3 28.4 6.6 34.1 1.5-44.9zm36.5 0l-2.7 17.5 1.2 45 6.7-34.1z" fill="#E4751F"/><path d="M179.4 193.5l-6.7 34.1 4.8 3.3 29.2-22.8 1-22.9zm-70.8-8.3l.8 22.9 29.2 22.8 4.8-3.3-6.6-34.1z" fill="#F6851B"/><path d="M179.8 261.9l.3-9.3-2.5-2.2h-37.7l-2.3 2.2.2 9.3-31.5-14.9 11 9 22.3 15.5h38.3l22.4-15.5 11-9z" fill="#C0AD9E"/><path d="M178.2 230.9l-4.8-3.3h-27.9l-4.8 3.3-2.5 22.1 2.3-2.2h37.7l2.5 2.2z" fill="#161616"/><path d="M278.3 114.2l8.5-40.8-12.7-37.9-96.9 71.9 37.2 31.5 52.6 15.4 11.6-13.5-5-3.6 8-7.3-6.2-4.8 8-6.1zM31.3 73.4l8.5 40.8-5.4 4 8 6.1-6.1 4.8 8 7.3-5 3.6 11.6 13.5 52.6-15.4 37.2-31.5L44 35.5z" fill="#763D16"/><path d="M267 154.2l-52.6-15.4 15.9 23.9-23.7 46 31.2-.4h46.5zm-163.5-15.4L51 154.2l-17.8 54.1h46.4l31.1.4-23.6-46zm71 26.4l3.3-57.7 15.2-41.1h-67.5l14.9 41.1 3.5 57.7 1.2 18.2.1 44.8h27.9l.2-44.8z" fill="#F6851B"/></svg>`;

function truncAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

function makeWalletBtn(opts: {
  iconSvg: string;
  label: string;
  connectedAddress: string | null;
  onClick: () => void;
}): { btn: HTMLButtonElement; setAddress(addr: string | null): void } {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wallet-connect-btn";

  function render(addr: string | null): void {
    const icon = document.createElement("span");
    icon.className = "wallet-btn-icon";
    icon.innerHTML = opts.iconSvg;
    const text = document.createElement("span");
    text.className = "wallet-btn-label";
    text.textContent = addr ? truncAddr(addr) : opts.label;
    btn.replaceChildren(icon, text);
    btn.classList.toggle("connected", !!addr);
  }

  render(opts.connectedAddress);
  btn.onclick = opts.onClick;
  return { btn, setAddress: render };
}

/** Mount the wallet bar into the given container element. Call once from main.ts. */
export function mountWalletBar(session: SwapSession, container: HTMLElement, onConnect?: () => void): void {
  const errLog = container;

  const { btn: irisBtn, setAddress: setIrisAddress } = makeWalletBtn({
    iconSvg: IRIS_SVG,
    label: "Connect Iris",
    connectedAddress: session.nock?.pkh ?? null,
    onClick: () =>
      runBusy(irisBtn, async () => {
        session.nock = await connectIrisWallet();
        setIrisAddress(session.nock.pkh);
        reverseResolveNock(session.nock.pkh).then(name => setIrisAddress(name)).catch(() => {});
        onConnect?.();
      }).catch((e) => logErr(errLog, e)),
  });

  const { btn: evmBtn, setAddress: setEvmAddress } = makeWalletBtn({
    iconSvg: FOX_SVG,
    label: "Connect MetaMask",
    connectedAddress: session.evm ?? null,
    onClick: () =>
      runBusy(evmBtn, async () => {
        session.evm = await connectEvmWallet();
        setEvmAddress(session.evm);
        reverseResolveEns(session.evm).then(name => setEvmAddress(name)).catch(() => {});
        onConnect?.();
      }).catch((e) => logErr(errLog, e)),
  });

  // Reverse-resolve already-connected wallets.
  if (session.nock?.pkh) {
    reverseResolveNock(session.nock.pkh).then(name => setIrisAddress(name)).catch(() => {});
  }
  if (session.evm) {
    reverseResolveEns(session.evm).then(name => setEvmAddress(name)).catch(() => {});
  }

  container.append(evmBtn, irisBtn);
}
