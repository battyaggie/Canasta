// Service worker: keeps the app on the phone so pass & play opens with no signal.
// scripts/build-web.mjs fills in BUILD and FILES.
const BUILD = '__BUILD__';
const FILES = __FILES__;
const CACHE = `canasta-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('canasta-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Online tables always go to the server.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // "/?room=ABCD" and "/?seed=3" are the same page as "/".
      const key = req.mode === 'navigate' ? '/' : req;
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        return (await cache.match('/', { ignoreSearch: true })) ?? Response.error();
      }
    }),
  );
});
