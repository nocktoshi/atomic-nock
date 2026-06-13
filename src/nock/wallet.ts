/**
 * Rose extension wallet — build with iris-wasm, sign via API 1 `nock_signTx`, send protobuf as-is.
 */
import { getGrpcWebUrl, formatWalletError } from "../grpc.js";
import { isPlausibleWalletAddress } from "./balance.js";
import {
  isRoseWasmPanic,
} from "./tx.js";
import { Digest, GrpcClient, NockchainTx, Note, TxBuilder } from '@nockchain/rose-ts'
import { prepareBuiltTx, finalizeAndBroadcast } from "./broadcast.js";


/** Rose extension RPC API v1 (must match extension `RPC_API_VERSION`). */
const IRIS_RPC_API_V1 = "1.0.0";

/** Rose SDK provider methods (API 1). */
const IRIS_SIGN_TX = "nock_signTx";


// NOTE: previous client-side tx-id workarounds (stripPkhSignatureOnHaxSpends,
// ensureCorrectHaxPreimageHashes) were removed. The id is now computed by rose-wasm's
// rawTxV1CalcId, whose Witness::hash hashes the hax preimage structurally (matching the
// node) and includes the pkh signature — so no client-side patching is needed, and the
// node accepts the declared id directly.

/** Sign params for `nock_signTx` (native `NockchainTx` + optional input notes). */
export type RoseSignTxParams = {
  tx: NockchainTx;
  notes?: Note[];
};

// Signer-independent halves of the tx pipeline live in broadcast.ts (shared
// with the solver daemon). Re-exported for back-compat.
export { ensureHaxPreimagesOnSpendWitnesses } from "./broadcast.js";

/** Raw response of `nock_signMessage` (serialized across the extension boundary). */
export type RawSignMessageResponse = {
  signature: unknown;
  publicKey: unknown;
};

export type NockWalletProvider = {
  _isRoseWrapper?: boolean;
  connect(): Promise<{ pkh?: string; address?: string }>;
  /** API 1.0 — signs native `NockchainTx` (sign-only; we broadcast via gRPC). */
  signTx(params: RoseSignTxParams): Promise<NockchainTx>;
  /** API 1.0 — signs an arbitrary message (used for server sign-in). */
  signMessage(message: string): Promise<RawSignMessageResponse>;
};

/** Solver-only: one Nockchain tx per block after broadcast clears. */
export type NockTxGateHooks = {
  onBroadcast(txId: string): void;
  onBroadcastFailed(err: unknown): void;
};

export type NockWalletSession = {
  pkh: Digest;
  address?: string;
  provider: NockWalletProvider;
  grpc: GrpcClient;
  /** Present on the headless solver wallet; unused in the browser. */
  txGate?: NockTxGateHooks;
};

declare global {
  interface Window {
    nockchain?: {
      request<T = unknown>(args: {
        method: string;
        params?: unknown;
        timeout?: number;
        api?: string;
      }): Promise<T>;
      on?(event: string, listener: (...args: unknown[]) => void): void;
      off?(event: string, listener: (...args: unknown[]) => void): void;
    };
  }
}

/**
 * Race a promise against a hard client-side deadline. The Rose extension can stop
 * responding entirely (message channel dies) and never resolve OR reject — which
 * leaves the calling button stuck disabled forever. This guarantees a rejection so
 * `runBusy`'s finally re-enables the button and the user can retry.
 */
function withTimeout<T>(p: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Rose ${method} timed out after ${Math.round(ms / 1000)}s — the extension may be ` +
            `unresponsive. Reopen/unlock Rose (or reload the extension) and try again.`
          )
        ),
      ms
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

async function irisRequest<T>(
  nockchain: NonNullable<Window["nockchain"]>,
  args: { method: string; params?: unknown; timeout?: number; api?: string }
): Promise<T> {
  try {
    // Grace beyond the RPC-declared timeout so a well-behaved extension can reject
    // first; this only fires if the extension is truly hung.
    const deadline = (args.timeout ?? 60_000) + 15_000;
    return await withTimeout(nockchain.request<T>(args), deadline, args.method);
  } catch (err) {
    console.error(`Rose ${args.method} rejected:`, err);
    if (err instanceof Error && err.cause != null) {
      console.error(`Rose ${args.method} cause:`, err.cause);
    }
    if (!(err instanceof Error)) {
      throw new Error(formatWalletError(err), { cause: err });
    }
    throw err;
  }
}

function unwrapSignedTxResponse(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result === "object") {
    if ("tx" in result) return (result as { tx: unknown }).tx;
    if ("rawTx" in result) return (result as { rawTx: unknown }).rawTx;
  }
  return result;
}

function isNockTxGateBusy(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur != null; i++) {
    if (cur instanceof Error) {
      if (cur.name === "NockTxBusyError" || cur.message.includes("nock-tx-gate")) return true;
      cur = cur.cause;
      continue;
    }
    break;
  }
  return false;
}

function formatRoseSignFailure(err: unknown): string {
  const msg = formatWalletError(err);
  if (isRoseWasmPanic(err)) {
    return (
      `${msg} — iris-wasm panicked while decoding a Tip5 digest (invalid sellerPkh, lockFirstName, ` +
      `buyerPkh, or note name in swap JSON). Hard-reload this page (wasm is poisoned until reload), ` +
      `re-import seller swap JSON, then retry Claim NOCK.`
    );
  }
  return msg;
}

function createRoseProvider(nockchain: NonNullable<Window["nockchain"]>): NockWalletProvider {
  return {
    _isRoseWrapper: true,
    async connect() {
      try {
        const result = await irisRequest<
          { pkh?: string; address?: string } & Record<string, unknown>
        >(nockchain, {
          method: "nock_connect",
          timeout: 120_000,
        });
        return result;
      } catch (err) {
        throw new Error(`Rose nock_connect: ${formatWalletError(err)}`, { cause: err });
      }
    },
    async signTx(params) {
      const notes = params.notes ?? [];
      try {
        const result = await irisRequest<{ tx: NockchainTx }>(nockchain, {
          method: IRIS_SIGN_TX,
          params: { tx: params.tx, notes },
          api: IRIS_RPC_API_V1,
          timeout: 300_000,
        });
        const signed = unwrapSignedTxResponse(result);
        if (signed != null && typeof signed === "object") {
          return signed as NockchainTx;
        }
        throw new Error("Rose nock_signTx returned no signed transaction");
      } catch (err) {
        throw new Error(formatWalletError(err), { cause: err });
      }
    },
    async signMessage(message) {
      try {
        return await irisRequest<RawSignMessageResponse>(nockchain, {
          method: "nock_signMessage",
          params: { message },
          api: IRIS_RPC_API_V1,
          timeout: 120_000,
        });
      } catch (err) {
        throw new Error(formatWalletError(err), { cause: err });
      }
    },
  };
}

export async function waitForRoseWallet(timeoutMs = 5000): Promise<NonNullable<Window["nockchain"]>> {
  if (window.nockchain?.request) return window.nockchain;

  return new Promise((resolve, reject) => {
    const deadline = window.setTimeout(() => {
      window.removeEventListener("nockchain#initialized", onInit);
      reject(
        new Error(
          "Rose wallet not found. Install the Rose extension and refresh this page."
        )
      );
    }, timeoutMs);

    const onInit = () => {
      if (window.nockchain?.request) {
        window.clearTimeout(deadline);
        window.removeEventListener("nockchain#initialized", onInit);
        resolve(window.nockchain);
      }
    };

    window.addEventListener("nockchain#initialized", onInit);
    onInit();
  });
}

export async function connectRoseWallet(): Promise<NockWalletSession> {
  const injected = await waitForRoseWallet();
  const provider = createRoseProvider(injected);
  const raw = await provider.connect();
  const rawPkh = pickString(raw, ["pkh", "PKH"]) as Digest;
  if (!rawPkh) throw new Error("Rose connect did not return pkh");

  const address = isPlausibleWalletAddress(rawPkh)
    ? rawPkh
    : pickWalletAddress(raw);

  const grpc = new GrpcClient(getGrpcWebUrl());
  return {
    pkh: rawPkh,
    address,
    provider,
    grpc,
  };
}

function pickWalletAddress(
  obj: { pkh?: string; address?: string } & Record<string, unknown>
): string | undefined {
  for (const k of ["address", "walletAddress", "wallet_address", "account"]) {
    const v = obj[k];
    if (typeof v === "string" && isPlausibleWalletAddress(v)) return v.trim();
  }
  return undefined;
}

function pickString(
  obj: { pkh?: string; address?: string } & Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export type ClaimSignContext = {
  /** Input notes keyed by `noteNameKey` for `nock_signTx` (native iris-wasm `Note`). */
  noteByKey: Map<string, Note>;
  /** HTLC OR lock root — validated on the hax spend witness before broadcast. */
  htlcLockRoot?: Digest;
  /** Expected hNock digest — preimage jam must hash to this on the claim spend. */
  hNock?: Digest;
  /** Minimum origin-page among inputs (for post-bythos full LMP check). */
  minOriginPage?: bigint;
};

/**
 * Build → sign (`nock_signTx`) → canonicalize tx id from spends → gRPC send.
 *
 * Pass the native Notes that were supplied to simpleSpend / SpendBuilder so the
 * Rose extension can display the actual inputs in the "Sign Raw Transaction" dialog
 * and produce a correctly authorized spend. Without them you get "Inputs (0)".
 */
export async function signAndSendRoseTx(
  wallet: NockWalletSession,
  builder: TxBuilder,
  inputNotes: Note[] = []
): Promise<string> {
  // Build + apply the pre-sign patches (shared with the solver daemon).
  const nockTx = prepareBuiltTx(builder, inputNotes);

  let signedNockTx: NockchainTx;
  try {
    signedNockTx = await wallet.provider.signTx({
      tx: nockTx,
      notes: inputNotes,
    });
  } catch (err) {
    if (isNockTxGateBusy(err)) throw err;

    const serverWallet = wallet.provider._isRoseWrapper === false;
    const hint = serverWallet
      ? "Solver defers to the next block (one Nockchain tx per block)."
      : "Unlock Rose, approve the popup (check it is not blocked), then retry Claim NOCK.";
    throw new Error(`Rose signing failed: ${formatRoseSignFailure(err)}. ${hint}`, { cause: err });
  }

  // Re-sync hax → rose id calc → protobuf → gRPC send (shared with the daemon).
  try {
    const txId = await finalizeAndBroadcast(wallet.grpc, signedNockTx);
    wallet.txGate?.onBroadcast(txId);
    return txId;
  } catch (err) {
    wallet.txGate?.onBroadcastFailed(err);
    throw err;
  }
}

/** @deprecated Use connectRoseWallet — kept for existing UI imports. */
export const connectIrisWallet = connectRoseWallet;

/** @deprecated Use signAndSendRoseTx — kept for existing orchestration imports. */
export const signAndSendIrisTx = signAndSendRoseTx;
