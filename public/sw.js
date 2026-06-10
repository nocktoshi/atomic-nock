/* Atomic Nock service worker — Web Push display + click-through.
 * Payload shape (see worker/src/notify.ts): { title, body, url } */

self.addEventListener("push", (event) => {
  let data = { title: "Atomic Nock", body: "Swap update", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* non-JSON payload — show the default */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/android-chrome-192x192.png",
      badge: "/favicon-32x32.png",
      data: { url: data.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      // Focus an existing app tab if one is open, else open a new one.
      for (const tab of tabs) {
        if ("focus" in tab) {
          tab.navigate(url).catch(() => {});
          return tab.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
