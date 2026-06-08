import init, * as Rose from '@nockchain/rose-wasm';

let ready = false;

export async function initRoseWasm(): Promise<void> {
    if (ready) return;
    await init();
    Rose.initPanicHook();
    ready = true;
}

export async function getRoseWasm() {
    await initRoseWasm();
    return Rose;
}

export type {
    SpendBuilder
} from '@nockchain/rose-wasm';

export {
    tasBelts,
    jam,
    hashPreimage,
} from '@nockchain/rose-wasm';
