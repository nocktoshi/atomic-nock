import type { Hex } from "viem";

/**
 * Client-only secret storage for the SELLER's preimage.
 *
 * SECURITY: the preimage must never reach the shared KV backend — it unlocks both
 * legs of the swap until the seller reveals it on-chain. It stays in the browser
 * via IndexedDB (not localStorage, not KV). The buyer needs no secret store: their
 * preimage is public on-chain after the seller withdraws (re-derived via
 * findPreimageFromSwapWithdraw).
 */
const DB_NAME = "atomic-nock";
const STORE = "secrets";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export interface SecretStore {
  getSellerPreimage(hEvm: Hex): Promise<Uint8Array | null>;
  putSellerPreimage(hEvm: Hex, preimageJam: Uint8Array): Promise<void>;
}

export const secretStore: SecretStore = {
  async getSellerPreimage(hEvm) {
    const v = await tx<unknown>("readonly", (s) => s.get(`seller:${hEvm}`));
    if (!v) return null;
    return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
  },
  async putSellerPreimage(hEvm, preimageJam) {
    // Store a copy of the bytes (structured clone handles Uint8Array).
    await tx("readwrite", (s) => s.put(preimageJam, `seller:${hEvm}`));
  },
};
