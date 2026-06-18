/**
 * On-demand solver quotes via RFQ — no polling the quote board. The UI posts a
 * sized request when the amount field changes; the solver (on another host)
 * prices it and writes a short-lived response to KV.
 */
import { useEffect, useRef, useState } from "react";
import { KV_URL } from "../config.js";
import type { RfqSide, SolverRfqResponse } from "../market/solver-rfq.js";

/** Wait for typing to settle before posting a sized RFQ. */
const DEBOUNCE_MS = 700;
/** Client timeout — comfortably above the worker's RFQ_HOLD_MS hold (~8s). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Bounded re-POSTs when the worker returns a transient busy/expired. */
const MAX_ATTEMPTS = 2;

export interface SolverRfqState {
  quote: SolverRfqResponse | null;
  loading: boolean;
  online: boolean | null;
}

function baseUrl(): string | null {
  const u = KV_URL?.replace(/\/$/, "");
  return u || null;
}

function isPositiveAmount(v: string): boolean {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0;
}

async function fetchStatus(): Promise<boolean> {
  const base = baseUrl();
  if (!base) return false;
  const res = await fetch(`${base}/solver/status`);
  if (!res.ok) return false;
  const { online } = (await res.json()) as { online?: boolean };
  return !!online;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * POST a sized RFQ that the worker holds open until the solver answers over the
 * queue — the response IS the quote (no polling). A transient `busy`/`expired`
 * is re-POSTed a bounded number of times.
 */
async function postRfqHeld(
  side: RfqSide,
  amountIn: string,
  signal?: AbortSignal
): Promise<SolverRfqResponse> {
  const base = baseUrl();
  if (!base) throw new Error("API not configured");
  let last: SolverRfqResponse | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(`${base}/solver/rfq`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side, amountIn }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status === 429) {
      const retrySec = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(retrySec) && retrySec > 0 ? retrySec : 1) * 1000, signal);
      continue;
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `RFQ failed (${res.status})`);
    }
    last = (await res.json()) as SolverRfqResponse;
    if (last.status !== "busy" && last.status !== "expired") return last;
  }
  return (
    last ?? { rfqId: "", side, status: "expired", expiresAt: Date.now(), reason: "quote timed out — try again" }
  );
}

/** Request a real quote when `amountIn` changes (debounced). */
export function useSolverRfq(side: RfqSide, amountIn: string): SolverRfqState {
  const [quote, setQuote] = useState<SolverRfqResponse | null>(null);
  const [fetching, setFetching] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const reqId = useRef(0);

  useEffect(() => {
    if (!baseUrl()) return;
    let alive = true;
    void fetchStatus()
      .then((o) => {
        if (alive) setOnline(o);
      })
      .catch(() => {
        if (alive) setOnline(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const trimmed = amountIn.trim();

  // Debounce the amount before any RFQ work — typing must not fire requests or
  // flip the UI into a quoting state on every keystroke.
  useEffect(() => {
    if (!isPositiveAmount(trimmed)) {
      const t = window.setTimeout(() => {
        setDebouncedAmount("");
        setQuote(null);
        setFetching(false);
      }, 0);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setDebouncedAmount(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [trimmed]);

  useEffect(() => {
    if (!baseUrl() || !debouncedAmount) return;

    const id = ++reqId.current;
    const ac = new AbortController();
    void (async () => {
      setFetching(true);
      try {
        const done = await postRfqHeld(side, debouncedAmount, ac.signal);
        if (reqId.current !== id || ac.signal.aborted) return;
        setOnline(done.status !== "offline");
        setQuote(done);
      } catch (e) {
        if (reqId.current !== id || ac.signal.aborted) return;
        if ((e as Error).name === "AbortError") return;
        setQuote({
          rfqId: "",
          side,
          status: "offline",
          expiresAt: Date.now(),
          reason: (e as Error).message,
        });
      } finally {
        if (reqId.current === id) setFetching(false);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [side, debouncedAmount]);

  const hasAmount = isPositiveAmount(trimmed);
  const settled = quote != null && quote.status !== "pending";
  const amountMatches = !quote?.amountIn || quote.amountIn === trimmed;
  const sideMatches = quote?.side === side;
  const showQuote = settled && amountMatches && sideMatches;
  const loading = hasAmount && fetching;

  // Surface terminal failures (rejected/expired) even though there's no price.
  const terminal =
    quote != null &&
    quote.status !== "ready" &&
    quote.status !== "pending" &&
    amountMatches &&
    sideMatches;

  return {
    quote: hasAmount && (showQuote || terminal) ? quote : null,
    loading,
    online,
  };
}

/** One-shot RFQ for flows that need a quote outside a form (e.g. 1Click hop). */
export async function requestSolverRfq(
  side: RfqSide,
  amountIn: string
): Promise<SolverRfqResponse> {
  return postRfqHeld(side, amountIn);
}