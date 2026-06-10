/**
 * Swap-transition notifications. `swapEvents` is a pure diff of two swap records
 * → events for the counterparty; `dispatch` fans them out over each recipient's
 * enabled channels. Always called via ctx.waitUntil AFTER the KV write — a
 * notification failure must never fail (or slow) the swap mutation.
 */
import { buildPushPayload, type VapidKeys } from "@block65/webcrypto-web-push";
import type { Env } from "./swaps.js";
import type { SwapRecord } from "./contract.js";
import { loadProfile, removePushSubscription, type PushSub } from "./profile.js";

export interface SwapEvent {
  recipientPkh: string;
  title: string;
  body: string;
  /** Deep link to the swap. */
  url: string;
}

/** UI symbol for the quote leg ("USDC" unless the swap says otherwise). */
function symbolOf(rec: SwapRecord): string {
  return rec.token === "WNOCK" ? "wNOCK" : "USDC";
}

function swapUrl(env: Env, rec: SwapRecord): string {
  const base = (env.APP_URL ?? "https://atomicnock.com").replace(/\/$/, "");
  return `${base}/swap/${rec.hEvm}`;
}

/** A field that newly appeared on `next` (transition edge). */
function appeared(prev: SwapRecord | null, next: SwapRecord, field: string): boolean {
  return !prev?.[field] && Boolean(next[field]);
}

/**
 * Derive notification events for the prev→next transition. Recipient is always
 * the counterparty of whoever acted (the actor just watched it happen live).
 */
export function swapEvents(prev: SwapRecord | null, next: SwapRecord): SwapEvent[] {
  const out: Omit<SwapEvent, "url">[] = [];
  const sym = symbolOf(next);
  const seller = String(next.sellerPkh ?? "");
  const buyer = String(next.buyerPkh ?? "");

  if (appeared(prev, next, "buyerPkh") && prev != null) {
    // A buyer claimed the seller's open swap (creation with preset buyer is not a claim).
    out.push({
      recipientPkh: seller,
      title: "Swap claimed",
      body: `A buyer claimed your swap — lock your NOCK to continue.`,
    });
  }
  if (appeared(prev, next, "lockFirstName")) {
    out.push({
      recipientPkh: buyer,
      title: "Seller locked NOCK",
      body: `The seller locked NOCK on Nockchain — verify it, then lock your ${sym}.`,
    });
  }
  if (appeared(prev, next, "usdcLockTxHash")) {
    out.push({
      recipientPkh: seller,
      title: `${sym} locked`,
      body: `The buyer locked ${next.usdcAmount ?? ""} ${sym} on Base — withdraw to complete the swap.`,
    });
  }
  if (appeared(prev, next, "usdcWithdrawTxHash")) {
    out.push({
      recipientPkh: buyer,
      title: "Preimage revealed",
      body: `The seller withdrew ${sym} — claim your NOCK now.`,
    });
  }
  if (appeared(prev, next, "nockClaimTxId")) {
    out.push({
      recipientPkh: seller,
      title: "Swap complete 🎉",
      body: "The buyer claimed their NOCK — the swap is finished.",
    });
  }
  if (appeared(prev, next, "nockRefundTxId")) {
    out.push({
      recipientPkh: buyer,
      title: "Seller refunded NOCK",
      body: "The seller reclaimed their locked NOCK — this swap is winding down.",
    });
  }
  if (appeared(prev, next, "usdcRefundTxHash")) {
    out.push({
      recipientPkh: seller,
      title: `Buyer refunded ${sym}`,
      body: `The buyer reclaimed their locked ${sym} — this swap is winding down.`,
    });
  }

  return out
    .filter((e) => e.recipientPkh)
    .map((e) => ({ ...e, url: "" })); // url filled by dispatch (needs env)
}

/** Send one Telegram message; swallow failures (best-effort). */
export async function sendTelegram(env: Env, chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("telegram send failed:", e);
  }
}

/**
 * Send one Web Push (RFC 8291 aes128gcm + VAPID via WebCrypto). Returns false
 * when the subscription is dead (404/410) so the caller can prune it.
 */
async function sendWebPush(
  env: Env,
  sub: PushSub,
  payload: { title: string; body: string; url: string }
): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return true;
  const vapid: VapidKeys = {
    subject: env.VAPID_SUBJECT ?? "https://atomicnock.com",
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  try {
    const { body, ...init } = await buildPushPayload(
      { data: payload, options: { ttl: 24 * 3600, urgency: "normal" } },
      sub,
      vapid
    );
    // workers-types' BodyInit rejects a bare Uint8Array; hand it the exact buffer.
    const res = await fetch(sub.endpoint, { ...init, body: body.slice().buffer });
    if (res.status === 404 || res.status === 410) return false; // dead subscription
  } catch (e) {
    console.error("web push send failed:", e);
  }
  return true;
}

/** Send one email via Resend's REST API; swallow failures (best-effort). */
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM ?? "Atomic Nock <notify@atomicnock.com>",
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) console.error("resend send failed:", res.status, await res.text());
  } catch (e) {
    console.error("email send failed:", e);
  }
}

/** Fan an event out over the recipient's enabled channels. Best-effort. */
export async function dispatch(env: Env, rec: SwapRecord, events: SwapEvent[]): Promise<void> {
  for (const ev of events) {
    try {
      const profile = await loadProfile(env, ev.recipientPkh);
      const url = swapUrl(env, rec);
      if (profile.telegram && profile.prefs?.telegram !== false) {
        await sendTelegram(env, profile.telegram.chatId, `${ev.title}\n${ev.body}\n${url}`);
      }
      if (profile.prefs?.push !== false) {
        for (const sub of profile.push ?? []) {
          const alive = await sendWebPush(env, sub, { title: ev.title, body: ev.body, url });
          if (!alive) {
            await removePushSubscription(env, ev.recipientPkh, sub.endpoint).catch(() => {});
          }
        }
      }
      if (profile.email?.verified && profile.prefs?.email !== false) {
        await sendEmail(
          env,
          profile.email.address,
          `Atomic Nock — ${ev.title}`,
          `${ev.body}\n\n${url}`
        );
      }
    } catch (e) {
      console.error("notify dispatch failed:", e);
    }
  }
}
