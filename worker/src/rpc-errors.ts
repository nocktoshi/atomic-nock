/**
 * SwapError does not survive Workers RPC as a typed subclass — encode status in
 * the message at the DO boundary and decode it in the worker client.
 */
import { SwapError } from "./errors.js";

const PREFIX = "__SWAP__";

export function throwRpcError(e: unknown): never {
  if (e instanceof SwapError) {
    throw new Error(`${PREFIX}${e.status}__${e.message}`);
  }
  throw e;
}

export function catchRpcError(e: unknown): never {
  if (e instanceof SwapError) throw e;
  if (e instanceof Error) {
    const m = e.message.match(new RegExp(`^${PREFIX}(\\d+)__(.+)$`));
    if (m) throw new SwapError(Number(m[1]), m[2]);
    throw new SwapError(500, e.message);
  }
  throw new SwapError(500, String(e));
}

/** Run a Market RPC call and map remote errors back to SwapError. */
export async function marketRpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    catchRpcError(e);
  }
}