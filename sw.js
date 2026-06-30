const CACHE_NAME = 'planner-v5';
const STATIC_ASSETS = [
  './login.html',
  './planner.html',
  './shopping.html',
  './planner.js',
  './shopping.js',
  './apiClient.js',
  './config.js',
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // API calls: network first, no caching
  if (url.origin !== location.origin) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ message: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }
  // Static assets: cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      });
      return cached || network;
    })
  );
});
