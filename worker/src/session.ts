/**
 * Stateless sign-in: a server-issued, HMAC-bound challenge that the user signs
 * with Iris, exchanged for a short-lived HMAC session token bound to their pkh.
 *
 * No secret ever reaches the browser. SESSION_SECRET is a Worker secret used
 * only to (a) MAC the login challenge so the client can't forge its expiry/pkh,
 * and (b) sign/verify session tokens.
 *
 *   GET  /auth/challenge?pkh=<pkh>  -> { challenge, challengeMac }
 *   POST /auth/login { challenge, challengeMac, pubkeyHex, signature }
 *        -> { token }   (Authorization: Bearer <token> on writes)
 */

const CHALLENGE_TTL_MS = 2 * 60_000; // 2 minutes to sign
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000; // 7 day session

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeStr(s: string): string {
  return b64urlEncode(enc.encode(s));
}

function b64urlDecodeStr(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return decodeURIComponent(
    Array.from(bin, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  );
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Challenge {
  challenge: string;
  challengeMac: string;
}

/** Issue a signed login challenge for a given pkh. */
export async function makeChallenge(pkh: string, secret: string): Promise<Challenge> {
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const rand = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  // The full string the user signs in Iris.
  const challenge = `atomicnock-login|${pkh}|${exp}|${rand}`;
  return { challenge, challengeMac: await hmac(secret, challenge) };
}

/** Validate a previously-issued challenge; returns the bound pkh or null. */
export async function validateChallenge(
  challenge: string,
  challengeMac: string,
  secret: string
): Promise<string | null> {
  const expected = await hmac(secret, challenge);
  if (!timingSafeEqual(expected, challengeMac)) return null;
  const parts = challenge.split("|");
  if (parts.length !== 4 || parts[0] !== "atomicnock-login") return null;
  const pkh = parts[1];
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return pkh;
}

/** Mint a session token bound to a pkh. */
export async function issueToken(pkh: string, secret: string): Promise<string> {
  const payload = b64urlEncodeStr(
    JSON.stringify({ pkh, exp: Date.now() + SESSION_TTL_MS })
  );
  const mac = await hmac(secret, payload);
  return `${payload}.${mac}`;
}

/** Verify a session token; returns the bound pkh or null. */
export async function verifyToken(
  token: string | null,
  secret: string
): Promise<string | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(expected, mac)) return null;
  try {
    const { pkh, exp } = JSON.parse(b64urlDecodeStr(payload)) as {
      pkh: string;
      exp: number;
    };
    if (!pkh || !Number.isFinite(exp) || Date.now() > exp) return null;
    return pkh;
  } catch {
    return null;
  }
}

/** Pull the bearer token out of an Authorization header. */
export function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length);
}
