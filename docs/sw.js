/**
 * Offline service worker.
 *
 * The whole game is a few hundred kilobytes of code and zero binary art, so everything
 * is precached on install and served cache-first. Once installed, the game runs with
 * the device in airplane mode — which is the entire point of putting it on a phone.
 *
 * `self.__PRECACHE__` is rewritten by scripts/postbuild.mjs with the real hashed
 * filenames produced by the build.
 */

const VERSION = 'kemet-5b-mvkrsg15';
const PRECACHE = ["./","./index.html","./assets/index-B5waijW3.js","./assets/index-BB5MnrcA.css","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./manifest.webmanifest"] || ['./', './index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      // addAll fails the whole install if any single request 404s, which makes a bad
      // deploy silently un-installable. Fetch individually and tolerate misses.
      await Promise.all(PRECACHE.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        } catch (e) {
          // A missing optional asset should not block going offline-capable.
        }
      }));
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);

    // Navigations: serve the shell from cache so a cold offline launch works, but
    // refresh it in the background when the network is there.
    if (req.mode === 'navigate') {
      const cached = await cache.match('./index.html');
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put('./index.html', res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503 });
    }

    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // Hashed build assets are immutable, so caching them on first sight is safe.
      if (res.ok && (url.pathname.includes('/assets/') || url.pathname.includes('/icons/'))) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response('Offline', { status: 503 });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
