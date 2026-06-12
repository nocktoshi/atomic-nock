/**
 * RfqBoard — Durable Object holding the live RFQ queue + solver heartbeat.
 *
 * WHY A DO: this data is a real-time coordination channel (UI posts a sized
 * request; the solver must SEE it within one tick and answer; the UI polls the
 * answer). Cloudflare KV is eventually consistent — `list()` can lag new keys
 * by up to ~60s — which stranded fresh RFQs invisible to the solver ("my rfq
 * isn't updating"). A single DO instance gives strict ordering + instant
 * read-your-writes for every party. Records are ephemeral (≤55s), so storage
 * is tiny; everything is also persisted to DO storage to survive eviction.
 */
import type { RfqSide, RfqStatus } from "../../src/market/solver-rfq.js";

export interface BoardRfqRecord {
  id: string;
  side: RfqSide;
  token: "USDC";
  amountIn: string;
  createdAt: number;
  expiresAt: number;
  status: RfqStatus;
  amountOut?: string;
  pricePerNock?: number;
  maxAmountIn?: string;
  reason?: string;
  respondedAt?: number;
  solverPkh?: string;
}

/** Solver must heartbeat within this window to count as online. */
export const HEARTBEAT_MAX_AGE_MS = 55_000;
/** An unanswered RFQ expires after this (covers one slow solver tick). */
const RFQ_TTL_MS = 55_000;
/** Answered records linger briefly so the UI's next poll can read them. */
const ANSWERED_LINGER_MS = 120_000;

const RECORD_PREFIX = "rfq:";
const HEARTBEAT_KEY = "heartbeat";

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minimal slice of DurableObjectStorage the board uses (kept small so unit
 *  tests can hand in a Map-backed fake without miniflare). */
export interface BoardStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export class RfqBoard {
  private readonly storage: BoardStorage;

  constructor(state: { storage: BoardStorage }) {
    this.storage = state.storage;
  }

  /** DO entrypoint — tiny internal REST surface, called only by our worker. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/heartbeat" && req.method === "POST") {
        const { pkh } = (await req.json()) as { pkh?: string };
        await this.storage.put(HEARTBEAT_KEY, { pkh: pkh ?? "", ts: Date.now() });
        return Response.json({ ok: true });
      }
      if (path === "/status" && req.method === "GET") {
        return Response.json({ online: await this.online() });
      }
      if (path === "/create" && req.method === "POST") {
        const { side, amountIn } = (await req.json()) as { side: RfqSide; amountIn: string };
        if (!(await this.online())) return Response.json({ error: "offline" }, { status: 503 });
        const now = Date.now();
        const rec: BoardRfqRecord = {
          id: randomId(),
          side,
          token: "USDC",
          amountIn,
          createdAt: now,
          expiresAt: now + RFQ_TTL_MS,
          status: "pending",
        };
        await this.storage.put(RECORD_PREFIX + rec.id, rec);
        return Response.json(rec);
      }
      if (path === "/pending" && req.method === "GET") {
        const all = await this.storage.list<BoardRfqRecord>({ prefix: RECORD_PREFIX });
        const now = Date.now();
        const pending: BoardRfqRecord[] = [];
        for (const [key, rec] of all) {
          // Opportunistic cleanup: answered records linger briefly for the
          // UI's polls; everything else past its time is dropped.
          const cutoff =
            rec.status === "pending" ? rec.expiresAt : (rec.respondedAt ?? rec.expiresAt) + ANSWERED_LINGER_MS;
          if (now > cutoff) {
            await this.storage.delete(key);
            continue;
          }
          if (rec.status === "pending") pending.push(rec);
        }
        pending.sort((a, b) => a.createdAt - b.createdAt);
        return Response.json({ rfqs: pending });
      }
      if (path === "/respond" && req.method === "POST") {
        const body = (await req.json()) as {
          id: string;
          pkh: string;
          status: "ready" | "rejected";
          amountOut?: string;
          pricePerNock?: number;
          maxAmountIn?: string;
          reason?: string;
        };
        const key = RECORD_PREFIX + body.id;
        const rec = await this.storage.get<BoardRfqRecord>(key);
        if (!rec) return Response.json({ error: "rfq not found" }, { status: 404 });
        if (rec.status !== "pending") {
          return Response.json({ error: "rfq already answered" }, { status: 409 });
        }
        if (Date.now() > rec.expiresAt) {
          return Response.json({ error: "rfq expired" }, { status: 410 });
        }
        rec.status = body.status;
        rec.respondedAt = Date.now();
        rec.solverPkh = body.pkh;
        if (body.amountOut != null) rec.amountOut = body.amountOut;
        if (body.pricePerNock != null) rec.pricePerNock = body.pricePerNock;
        if (body.maxAmountIn != null) rec.maxAmountIn = body.maxAmountIn;
        if (body.reason != null) rec.reason = body.reason;
        await this.storage.put(key, rec);
        return Response.json(rec);
      }
      if (path === "/get" && req.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        const rec = await this.storage.get<BoardRfqRecord>(RECORD_PREFIX + id);
        if (!rec) return Response.json({ error: "not found" }, { status: 404 });
        if (rec.status === "pending" && Date.now() > rec.expiresAt) rec.status = "expired";
        return Response.json(rec);
      }
      return Response.json({ error: "bad board route" }, { status: 404 });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  private async online(): Promise<boolean> {
    const hb = await this.storage.get<{ ts: number }>(HEARTBEAT_KEY);
    return !!hb && Date.now() - hb.ts < HEARTBEAT_MAX_AGE_MS;
  }
}
