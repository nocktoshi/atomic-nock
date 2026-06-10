/** Shared display helpers and small hooks for the React UI. */
import { useEffect, useState } from "react";
import { tokenInfo } from "../config.js";
import { reverseResolveNock } from "./name-resolve.js";

export const NICKS_PER_NOCK = 65536;

/** Abbreviate a long id/address as `head…tail`. */
export function short(s: string | undefined, head = 8, tail = 6): string {
  if (!s) return "—";
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Format nicks (bigint) as a human NOCK string. */
export function formatNock(nicks: bigint): string {
  const nock = Number(nicks) / NICKS_PER_NOCK;
  return `${parseFloat(nock.toFixed(6))} NOCK`;
}

/** Display a nicks amount as a plain NOCK number string (empty when unset). */
export function nicksToNock(nicks: bigint | undefined | null): string {
  return nicks != null ? String(Number(nicks) / NICKS_PER_NOCK) : "";
}

/** Parse a NOCK input string into nicks, or undefined if not a finite number. */
export function nockToNicks(nock: string): bigint | undefined {
  const n = parseFloat(nock);
  return Number.isFinite(n) ? BigInt(Math.round(n * NICKS_PER_NOCK)) : undefined;
}

/** Token-aware quote formatting for swap cards: amount + price label. USDC
 *  renders dollars ($1.50, $0.0200 / NOCK); wNOCK renders the token amount and
 *  a ratio (50 wNOCK, 1.0200 wNOCK / NOCK). */
export function quoteDisplay(swap: {
  token?: "USDC" | "WNOCK";
  usdcAmount?: string;
  nockGift?: bigint;
}): { symbol: string; kind: "usd" | "nock"; amountLabel: string; priceLabel: string | null } {
  const t = tokenInfo(swap.token);
  const quoteNum = parseFloat(swap.usdcAmount ?? "");
  const giftNock = swap.nockGift != null ? Number(swap.nockGift) / NICKS_PER_NOCK : NaN;
  const amountLabel = !Number.isFinite(quoteNum)
    ? "—"
    : t.kind === "usd"
      ? `$${quoteNum.toFixed(2)}`
      : `${parseFloat(quoteNum.toFixed(6))} ${t.symbol}`;
  const priceLabel =
    Number.isFinite(quoteNum) && quoteNum > 0 && Number.isFinite(giftNock) && giftNock > 0
      ? t.kind === "usd"
        ? `$${(quoteNum / giftNock).toFixed(4)} / NOCK`
        : `${(quoteNum / giftNock).toFixed(4)} ${t.symbol} / NOCK`
      : null;
  return { symbol: t.symbol, kind: t.kind, amountLabel, priceLabel };
}

/** Approximate creation time (epoch seconds) for sorting: server `createdAt`
 *  when present, else the quote timelock (creation + a fixed window — close
 *  enough to order legacy records). */
export function swapCreatedAt(s: { createdAt?: number; usdcTimelock?: bigint }): number {
  if (typeof s.createdAt === "number") return s.createdAt;
  return s.usdcTimelock != null ? Number(s.usdcTimelock) : 0;
}

/** Comparator: newest swap first. */
export function byNewestSwap(
  a: { createdAt?: number; usdcTimelock?: bigint },
  b: { createdAt?: number; usdcTimelock?: bigint }
): number {
  return swapCreatedAt(b) - swapCreatedAt(a);
}

/** Truncate a wallet address for a button label: first 8 + … + last 6. */
export function truncAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

/** Canonical share URL for a swap id. */
export function swapUrl(swapId?: string): string | null {
  if(!swapId) return null
  return `${window.location.origin}/swap/${encodeURIComponent(swapId)}`;
}

/** Copy text to the clipboard with a textarea fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Reverse-resolve a Nockchain address to a friendly `.nock` name.
 * Returns the display text plus a `title` (full address) once a name is found.
 */
export function useResolvedNock(
  address: string | undefined,
  fallback?: string
): { text: string; title?: string } {
  const [name, setName] = useState<string | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    reverseResolveNock(address)
      .then((n) => {
        if (!alive) return;
        setResolvedFor(address);
        setName(n !== address ? n : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);

  if (resolvedFor === address && name) return { text: name, title: address };
  return { text: fallback ?? short(address) };
}
