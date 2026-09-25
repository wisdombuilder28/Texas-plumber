/* N.D. Flow Plumbing Co. — service worker */
const VERSION = "ndflow-v12";
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/motion.js",
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
  // Never cache admin, APIs, live JS modules, analytics, or Firebase.
  return (
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/api") ||
    url.pathname.endsWith("-live.js") ||
    url.pathname.endsWith("emailjs-config.js") ||
    url.pathname.endsWith("firebase-config.js") ||
    /googleapis|gstatic\.com\/firebasejs|firebaseio|firebasestorage|firestore|identitytoolkit|googletagmanager|google-analytics/.test(
      url.host + url.pathname,
    )
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isBypassed(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: "no-store" });
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

  // JS/CSS: network first so a deploy is not stuck on an old cached file.
  if (url.origin === self.location.origin && (req.destination === "script" || req.destination === "style")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const cache = await caches.open(RUNTIME);
            cache.put(req, res.clone());
          }
          return res;
        } catch {
          return (await caches.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin === self.location.origin && req.destination === "image") {
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
