import { formatGrpcError } from "../grpc.js";

/** Status/log helpers — moved verbatim from the old main.ts so behavior is identical. */

export function log(el: HTMLElement, msg: string, ok = false): void {
  el.textContent = msg;
  el.className = "log" + (ok ? " ok" : msg.startsWith("Error") ? " error" : "");
}

export function logErr(el: HTMLElement, err: unknown): void {
  console.error("atomic-nock error:", err);
  const msg = formatGrpcError(err);
  const cause =
    err instanceof Error && err.cause != null
      ? formatGrpcError(err.cause)
      : null;
  log(el, cause && cause !== msg ? `Error: ${msg}\n${cause}` : `Error: ${msg}`);
}

export function setWalletStatus(
  el: HTMLElement,
  kind: "iris" | "evm",
  connected: boolean,
  detail?: string
): void {
  el.textContent = connected
    ? `${kind === "iris" ? "Iris" : "MetaMask"}: ${detail ?? "connected"}`
    : `${kind === "iris" ? "Iris" : "MetaMask"}: not connected`;
  el.className = "wallet-status" + (connected ? " ok" : "");
}
