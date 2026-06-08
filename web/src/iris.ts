/**
 * Iris wasm (@nockbox/iris-sdk) — HTLC txs, gRPC, and extension signing (API 1.0).
 * Consumes via iris-sdk (which vendors the wasm) as recommended for extensions/apps.
 */
import init, * as Iris from '@nockbox/iris-sdk/wasm';

let ready = false;

/** Default fee-per-word for V1 engine (0.5 NOCK/word). */
export const DEFAULT_FEE_PER_WORD = 32768n;

export async function initIrisWasm(): Promise<void> {
  if (ready) return;
  await init();
  Iris.initPanicHook();
  ready = true;
}

/** After an iris-wasm panic, re-init may not recover — user should hard-reload the page. */
export async function resetIrisWasm(): Promise<void> {
  ready = false;
  await init();
  Iris.initPanicHook();
  ready = true;
}

export async function getIrisWasm() {
  await initIrisWasm();
  return Iris;
}

export type {
  SpendCondition,
  LockV2,
  Lock,
  Note,
  Name,
  RawTxV1,
  NockchainTx,
  WitnessData,
  Pkh,
  LockPrimitive,
  LockTim,
  Digest,
} from '@nockbox/iris-sdk/wasm';

export {
  jam,
  tasBelts,
  hashNoun,
  lockFromList,
  lockRootHash,
  pkhSingle,
} from '@nockbox/iris-sdk/wasm';
