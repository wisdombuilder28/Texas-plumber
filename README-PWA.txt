N.D. Flow Plumbing Co. — PWA update
===================================
Extract this zip over your project root, keeping the folder structure.

NEW files:
  manifest.webmanifest      app metadata (name, icons, standalone display, shortcuts)
  sw.js                     service worker (offline support + caching)
  pwa.js                    service worker registration + install button + iOS tip
  offline.html              shown when the phone has no connection
  favicon.ico               new favicon from your logo
  assets/icon-192.png
  assets/icon-512.png
  assets/icon-512-maskable.png
  assets/apple-touch-icon.png   (replaces the old one)

CHANGED files (overwrite yours):
  index.html                manifest + apple meta tags, install buttons, pwa.js
  styles.css                styles for the install button and iOS tip (appended at the end)
  vercel.json               no-store headers for sw.js / manifest (admin rules kept)

Notes:
- Install only works on HTTPS (your Vercel domain), not from file:// or localhost.
- Android/Chrome: an "Install App" button shows in the header and mobile menu.
- iPhone/Safari: a tip appears explaining Share > Add to Home Screen.
- /admin, /api, Firebase and analytics requests are never cached.
- When you change the site later, bump VERSION in sw.js (e.g. ndflow-v2) to push
  the update to already-installed users.
