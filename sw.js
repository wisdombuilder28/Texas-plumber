/* N.D. Flow Plumbing Co. — service worker */
const VERSION = "ndflow-v2";
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/script.js",
  "/manifest.json",
  OFFLINE_URL,
  "/assets/logo-mark.png",
  "/assets/logo-full.jpg",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.allSettled(
        names.filter((n) => n.startsWith("ndflow-") && n !== PRECACHE && n !== RUNTIME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isBypassed(url) {
  // Never cache the admin area, APIs, analytics or Firebase traffic.
  return (
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/api") ||
    /googleapis|gstatic\.com\/firebasejs|firebaseio|firebasestorage|firestore|identitytoolkit|googletagmanager|google-analytics/.test(
      url.host + url.pathname,
    )
  );
}

const STATIC_DESTINATIONS = ["style", "script", "image", "font"];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isBypassed(url)) return;

  // HTML navigations: network first, fall back to cache, then offline page.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(RUNTIME);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          return (
            (await caches.match(req)) ||
            (await caches.match("/index.html")) ||
            (await caches.match(OFFLINE_URL)) ||
            new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  if (url.origin === self.location.origin && STATIC_DESTINATIONS.includes(req.destination)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        const network = fetch(req)
          .then(async (res) => {
            if (res && res.ok) {
              const cache = await caches.open(RUNTIME);
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })(),
    );
    return;
  }

  // Cross-origin (fonts, CDN): stale-while-revalidate.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        const network = fetch(req)
          .then(async (res) => {
            if (res && (res.ok || res.type === "opaque")) {
              const cache = await caches.open(RUNTIME);
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })(),
    );
  }
});
