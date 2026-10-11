// Offline support: once opened, the app works without a connection (a cabin
// with no coverage). Shared sessions just queue changes until back online.
//
// Everything is network-first, falling back to the cache: the app is several
// ES modules, and serving a stale mix of them after a deploy would break it.
// Navigations fall back to the cached page, so /s/CODE links open offline
// too. /api/ is never cached.
//
// Bump CACHE only when changing what's precached or how.

const CACHE = 'scorepad-v4';
const PRECACHE = [
  '/',
  '/styles.css',
  '/app.js',
  '/core.js',
  '/rules.js',
  '/store.js',
  '/i18n.js',
  '/qrcodegen.js',
  '/manifest.webmanifest',
  '/fonts/fredoka-latin.woff2',
  '/fonts/fredoka-latin-ext.woff2',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/themes/cozy.svg',
  '/themes/hytte.svg',
  '/themes/knit.svg',
  '/themes/panel.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Navigations all get the one page; /s/CODE is routed client-side.
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())),
  );
});
