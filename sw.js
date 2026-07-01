// Bumped automatically by CI on every deploy (sed replaces this line)
const CACHE_NAME = 'planner-v16';

const STATIC_ASSETS = [
  './login.html',
  './planner.html',
  './shopping.html',
  './recipes.html',
  './planner.js',
  './shopping.js',
  './recipes.js',
  './apiClient.js',
  './config.js',
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all open tabs to reload so they get the fresh version
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API and external calls: network only, no caching
  if (url.origin !== location.origin) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ message: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // HTML and JS: network first, cache as offline fallback
  // This ensures users always see the latest version when online
  const isAppShell = /\.(html|js)$/.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/');
  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (images, manifest, etc.): cache first
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
