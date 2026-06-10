import { getNockRpcOverride, DEFAULT_NOCK_RPC } from "./app/settings.js";

/** gRPC-Web endpoint.
 * - User override (Settings → Nockchain RPC; localStorage + profile-synced) wins
 *   everywhere — it must be a grpc-web endpoint with browser CORS enabled.
 * - Dev: same-origin Vite proxy → `VITE_NOCK_GRPC_UPSTREAM`
 */
export function getGrpcWebUrl(): string {
  const override = getNockRpcOverride();
  if (override) return override.replace(/\/$/, "");

  const upstream = (import.meta.env.VITE_NOCK_GRPC_UPSTREAM ?? "").trim();

  if (import.meta.env.DEV && typeof window !== "undefined") {
    return window.location.origin;
  }

  if (upstream) return upstream.replace(/\/$/, "");
  return DEFAULT_NOCK_RPC;
}

/** Human hint when the browser cannot reach the gRPC-Web endpoint at all. */
export function grpcFetchFailureHint(endpoint: string): string {
  if (/localhost:8080|127\.0\.0\.1:8080/.test(endpoint)) {
    return (
      "gRPC-Web points at Envoy (:8080) but nothing is listening. "
    );
  }
  if (import.meta.env.DEV) {
    return (
      "Browser could not reach the gRPC proxy. Restart `npm run dev` in web/ and use " +
      "http://localhost:5173 (not a built preview on another port)."
    );
  }
  return (
    "Browser could not reach the Nock gRPC endpoint (network/CORS). "
  );
}

/** Iris / EIP-1193 wallet RPC errors (extension often wraps these poorly). */
export function formatWalletError(err: unknown): string {
  if (err == null) return String(err);

  if (typeof err === "object" && !(err instanceof Error)) {
    return formatGrpcError(err);
  }

  const maybe = err as Record<string, unknown>;
  if (typeof maybe.code === "number") {
    const msg =
      typeof maybe.message === "string"
        ? maybe.message
        : formatGrpcError(maybe.message);
    const data =
      maybe.data != null ? ` — ${formatGrpcError(maybe.data)}` : "";
    return `Iris RPC ${maybe.code}: ${msg}${data}`;
  }

  if (err instanceof Error) {
    const opaque =
      !err.message || err.message === "[object Object]" || err.message === "Error";
    if (err.cause != null) {
      const causeMsg = formatWalletError(err.cause);
      if (causeMsg && causeMsg !== "[object Object]") {
        const label =
          !opaque && err.message ? `${err.message}: ` : "";
        return `${label}${causeMsg}`;
      }
    }
    if (opaque) {
      const fromProps = formatGrpcError(err, 0, true);
      if (fromProps && fromProps !== "[object Object]") return fromProps;
    }
    if (err.message && err.message !== "[object Object]") {
      const base = err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
      const extra = formatGrpcError(err as unknown as Record<string, unknown>, 0, true);
      if (extra && extra !== base && !base.includes(extra)) {
        return `${base} — ${extra}`;
      }
      return base;
    }
    const fromProps = formatGrpcError(err, 0, true);
    if (fromProps && fromProps !== "[object Object]") return fromProps;
    return (
      "Iris wallet rejected signing (extension returned an opaque error). " +
      "Confirm the Iris popup is not blocked, then retry. If it persists, check the browser console for " +
      "`nock_signTx` errors."
    );
  }

  return formatGrpcError(err);
}

/** Unwrap gRPC / WASM / wallet-extension errors (avoid bare `[object Object]`). */
export function formatGrpcError(
  err: unknown,
  depth = 0,
  scanErrorProps = false
): string {
  if (depth > 5) return "(nested error)";
  if (err == null) return String(err);

  if (typeof err === "string") {
    if (/failed to fetch/i.test(err)) {
      return `${err} — ${grpcFetchFailureHint(getGrpcWebUrl())}`;
    }
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }

  if (err instanceof Error) {
    const parts: string[] = [];
    if (err.name && err.name !== "Error") parts.push(err.name);
    if (err.message && err.message !== "[object Object]") {
      const msg = /failed to fetch/i.test(err.message)
        ? `${err.message} — ${grpcFetchFailureHint(getGrpcWebUrl())}`
        : err.message;
      parts.push(msg);
    }
    if (err.cause != null) parts.push(`cause: ${formatGrpcError(err.cause, depth + 1)}`);
    if (scanErrorProps && depth < 3) {
      for (const k of ["code", "data", "reason", "details"] as const) {
        const v = (err as Error & Record<string, unknown>)[k];
        if (v != null) parts.push(`${k}: ${formatGrpcError(v, depth + 1)}`);
      }
    }
    if (parts.length) return parts.join(": ");
    if (err.stack) return err.stack.split("\n")[0] ?? err.stack;
  }

  if (typeof err === "object") {
    const o = err as Record<string, unknown>;

    if (o.error != null) {
      return formatGrpcError(o.error, depth + 1);
    }

    for (const key of [
      "message",
      "reason",
      "details",
      "data",
      "msg",
      "description",
      "statusText",
    ]) {
      const v = o[key];
      if (typeof v === "string" && v && v !== "[object Object]") return v;
      if (v != null && typeof v === "object") {
        return `${key}: ${formatGrpcError(v, depth + 1)}`;
      }
    }

    const keys = [
      ...Object.getOwnPropertyNames(o),
      ...Object.getOwnPropertySymbols(o)
        .map((s) => s.toString())
        .filter((s) => s !== "Symbol(react.element)"),
    ];
    if (keys.length > 0) {
      const parts: string[] = [];
      for (const k of keys) {
        try {
          const v = (o as Record<string | symbol, unknown>)[k as keyof typeof o];
          if (v === o) continue;
          const label = typeof k === "string" ? k : String(k);
          parts.push(
            `${label}: ${typeof v === "object" && v !== null
              ? formatGrpcError(v, depth + 1)
              : String(v)
            }`
          );
        } catch {
          parts.push(`${String(k)}: ?`);
        }
      }
      if (parts.length) return parts.join("; ");
    }

    const tag = Object.prototype.toString.call(err);
    if (tag !== "[object Object]") return tag;
  }

  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }

  return Object.prototype.toString.call(err);
}

export async function runStep<T>(
  step: string,
  fn: () => Promise<T> | T
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail =
      err instanceof Error && err.message
        ? err.message
        : formatGrpcError(err);
    throw new Error(`${step}: ${detail}`, { cause: err });
  }
}