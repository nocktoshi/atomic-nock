/**
 * Client-only "soft delete" for dashboard cards. Hiding a swap removes it from the
 * UI WITHOUT any server/KV calls — the swap record stays intact in the backend, so
 * it can be recovered by clearing this list. Stored in localStorage because it is a
 * purely local UI preference, not swap data.
 */
const KEY = "atomicnock:hidden-swaps";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function write(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

export function getHiddenSwaps(): Set<string> {
  return read();
}

export function isSwapHidden(hEvm: string): boolean {
  return read().has(hEvm.toLowerCase());
}

export function hideSwap(hEvm: string): void {
  const set = read();
  set.add(hEvm.toLowerCase());
  write(set);
}

export function unhideSwap(hEvm: string): void {
  const set = read();
  set.delete(hEvm.toLowerCase());
  write(set);
}
