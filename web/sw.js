// Service worker: keeps the app on the phone so pass & play opens with no signal.
// scripts/build-web.mjs fills in BUILD and FILES.
const BUILD = '__BUILD__';
const FILES = __FILES__;
const CACHE = `canasta-${BUILD}`;

// A new version waits until the page says it may take over (on the start page, see app.ts). Until then
// an open game keeps getting its own version's files, so old and new files are never mixed.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
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
        const res = await fetch(req);
        // The 3D table's people are not in the install list; keep them once fetched.
        if (res.ok && url.pathname.startsWith('/avatars/')) await cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match('/', { ignoreSearch: true })) ?? Response.error();
      }
    }),
  );
});
