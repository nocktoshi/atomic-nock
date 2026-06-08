import { base58 } from "@scure/base";
import { getIrisWasm, initIrisWasm, pkhSingle, type Note, type Digest  } from "../iris.js";
import { assertBase58Digest, BASE58_DIGEST_RE } from "./tx.js";
import type { NockWalletSession } from "./wallet.js";
import { Nicks } from '@nockbox/iris-sdk/wasm'

const NICKS_PER_NOCK = 65536n;

/** gRPC balance row shape (wire protobuf); convert once via `noteFromGrpcBalance`. */
export type GrpcBalanceEntry = { note?: unknown | null };

/** Balance entry with native iris-wasm `Note` (no protobuf in app logic). */
export type BalanceEntry = { note: Note; assets: bigint };

/** Stable key for matching iris `Note` / `Name` entries when ordering sign inputs. */
export function noteNameKey(
  noteOrName: { name?: { first: string; last: string } } | { first: string; last: string }
): string {
  if ("first" in noteOrName && "last" in noteOrName) {
    return `${noteOrName.first}:${noteOrName.last}`;
  }
  return `${noteOrName.name?.first ?? ""}:${noteOrName.name?.last ?? ""}`;
}

/** Base58-encoded cheetah wallet pubkey (nockblocks “address”), not a pkh / first name. */
export function isPlausibleWalletAddress(value: string): boolean {
  const s = value.trim();
  if (!s || s.startsWith("0x")) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  const n = s.length;
  if (n < 48 || n > 55) return false;
  try {
    const dec = base58.decode(s);
    // Wallet pubkeys / addresses are also represented as <=40 byte base58 values in this system.
    return dec.length <= 40;
  } catch {
    return false;
  }
}

function assertNoteName(note: Note, context: string): void {
  const name = note?.name;
  if (name == null || typeof name !== "object") {
    throw new Error(`${context}: balance note missing name`);
  }
  const first = (name as { first?: unknown }).first;
  const last = (name as { last?: unknown }).last;
  if (typeof first !== "string" || typeof last !== "string") {
    throw new Error(`${context}: balance note name is not base58 digests`);
  }
  assertBase58Digest(`${context} name.first`, first);
  assertBase58Digest(`${context} name.last`, last);
  // note_data keys are Digest (ZMap<Digest, NoteData>)
  const nd = (note as any)?.note_data;
  if (nd && typeof nd === "object") {
    for (const k of Object.keys(nd)) {
      if (BASE58_DIGEST_RE.test(k)) {
        assertBase58Digest(`${context} note_data key`, k);
      }
    }
  }
}

/** Single conversion point: gRPC protobuf note → native `Note`. */
export async function noteFromGrpcBalance(grpcNote: unknown): Promise<Note> {
  await initIrisWasm();
  const Iris = await getIrisWasm();
  const note = Iris.noteFromProtobuf(grpcNote as never);
  assertNoteName(note, "Balance note");
  return note;
}

function noteAssetsNicks(note: Note): bigint {
  if (typeof note !== "object" || note === null) return 0n;
  if ("assets" in note && note.assets != null) {
    return BigInt(String((note as { assets: unknown }).assets));
  }
  return 0n;
}

/** Parse gRPC balance rows into native notes (protobuf only at the RPC boundary). */
export async function parseBalanceEntries(
  entries: GrpcBalanceEntry[]
): Promise<BalanceEntry[]> {
  const out: BalanceEntry[] = [];
  for (const entry of entries) {
    if (!entry.note) continue;
    const note = await noteFromGrpcBalance(entry.note);
    out.push({ note, assets: noteAssetsNicks(note) });
  }
  return out;
}

export function pickLargestNote(
  entries: BalanceEntry[],
  minAssetsNicks: bigint
): { note: Note; assets: Nicks } {
  const ranked = entries
    .filter((c) => c.assets >= minAssetsNicks)
    .sort((a, b) => (a.assets > b.assets ? -1 : a.assets < b.assets ? 1 : 0));

  if (ranked.length === 0) {
    const need = Number(minAssetsNicks) / Number(NICKS_PER_NOCK);
    throw new Error(
      `No note with at least ${need} NOCK. Fund the wallet or lower the gift amount.`
    );
  }

  return { note: ranked[0].note, assets: ranked[0].assets.toString() as Nicks };
}

/** Smallest note that still covers `minAssetsNicks` (for fee-only spends). */
export function pickSmallestFeeNote(
  entries: BalanceEntry[],
  minAssetsNicks: bigint
): { note: Note; assets: bigint } {
  const ranked = entries
    .filter((c) => c.assets >= minAssetsNicks)
    .sort((a, b) => (a.assets < b.assets ? -1 : a.assets > b.assets ? 1 : 0));

  if (ranked.length === 0) {
    throw new Error(
      `No wallet note with at least ${Number(minAssetsNicks) / Number(NICKS_PER_NOCK)} NOCK for fees`
    );
  }

  return { note: ranked[0].note, assets: ranked[0].assets };
}

/** Note `name.first` for notes locked under a single-PKH spend (v1 p2pkh / nockblocks address). */
export async function firstNameFromWalletKey(walletKey: string): Promise<Digest> {
  const key = walletKey.trim();
  assertBase58Digest("wallet key", key);
  await initIrisWasm();
  const Iris = await getIrisWasm();
  const spendCondition = Iris.spendConditionNewPkh(pkhSingle(key as never));
  return Iris.spendConditionFirstName(spendCondition) as Digest;
}

/**
 * Fetch the current block height from the gRPC node by querying the wallet's
 * own first name.  Returns undefined if the wallet address is unavailable or
 * the RPC does not return a height (node still syncing, etc.).
 */
export async function fetchCurrentBlockHeight(
  session: NockWalletSession
): Promise<bigint | undefined> {
  const key = session.address ?? session.pkh;
  if (!key) return undefined;
  try {
    const firstName = await firstNameFromWalletKey(key);
    const balance = await session.grpc.getBalanceByFirstName(firstName);
    const h = balance?.height?.value;
    if (h == null) return undefined;
    return BigInt(h);
  } catch {
    return undefined;
  }
}

/** Balance at a note first name (e.g. HTLC output `lockFirstName` from swap JSON). */
export async function fetchNotesByFirstName(
  session: NockWalletSession,
  firstName: Digest
): Promise<{ notes: BalanceEntry[], height?: string }> {
  const balance = await session.grpc.getBalanceByFirstName(firstName);
  const notes = await parseBalanceEntries(balance?.notes ?? []);
  console.debug('found notes:', notes)
  return { notes, height: balance?.height?.value };
}

export async function fetchWalletNotes(
  session: NockWalletSession,
  overrideAddress?: string
): Promise<{ notes: BalanceEntry[]; query: string }> {
  const tried: string[] = [];
  const walletKeys = uniqueNonEmpty([
    overrideAddress,
    session.address,
    session.pkh,
  ]);

  for (const key of walletKeys) {
    const firstName = await firstNameFromWalletKey(key);
    tried.push(`firstName:${firstName.slice(0, 12)}…`);
    try {
      const balance = await session.grpc.getBalanceByFirstName(firstName);
      const notes = await parseBalanceEntries(balance?.notes ?? []);
      if (notes.length > 0) {
        console.debug(`Balance: ${notes.length} note(s) via firstName ${firstName.slice(0, 12)}…`);
        return { notes, query: `firstName ${firstName}` };
      }
    } catch (err) {
      console.debug("getBalanceByFirstName failed", key.slice(0, 12), err);
    }
  }

  const hint =
    walletKeys.length === 0
      ? "Paste your nockblocks wallet address (v1 p2pkh, ~51 chars)."
      : "Confirm the address matches nockblocks and the wallet has spendable notes.";

  throw new Error(
    `No notes returned from RPC. Tried: ${tried.join(", ") || "(none)"}. ${hint}`
  );
}

function uniqueNonEmpty(values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}