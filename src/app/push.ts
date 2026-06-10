/**
 * Browser push: service-worker registration + PushManager subscription,
 * paired with the Worker's /profile/push-* endpoints. Safari/iOS requires the
 * site installed as a PWA before `PushManager` exists — supported() covers it.
 */
import { VAPID_PUBLIC_KEY } from "../config.js";
import { pushSubscribe, pushUnsubscribe } from "./repo/profile-api.js";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    Boolean(VAPID_PUBLIC_KEY)
  );
}

/** Idempotent; safe to call on boot. No permission prompt happens here. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** The applicationServerKey bytes from the base64url VAPID public key. */
function vapidKeyBytes(): Uint8Array {
  const b64 = (VAPID_PUBLIC_KEY + "===".slice((VAPID_PUBLIC_KEY.length + 3) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Prompt (if needed), subscribe this browser, and register it on the profile. */
export async function enableBrowserPush(): Promise<void> {
  if (!pushSupported()) {
    throw new Error(
      "Browser push isn't available here — use a modern browser (on iOS, install the site to your home screen first)."
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const reg = await registerServiceWorker();
  if (!reg) throw new Error("Service worker failed to register.");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes().buffer as ArrayBuffer,
    }));
  await pushSubscribe(sub.toJSON());
}

/** Unsubscribe this browser and remove it from the profile. */
export async function disableBrowserPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await pushUnsubscribe(endpoint);
  }
}

/** Is THIS browser currently subscribed? (profile may list other browsers too) */
export async function isBrowserSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}
