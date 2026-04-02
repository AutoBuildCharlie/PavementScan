/* ================================================================
   PAVEMENTSCAN — Service Worker
   Caches app shell for offline/fast load. Network-first for API calls.
   ================================================================ */

const CACHE = 'pavementscan-v1';
const APP_SHELL = [
  '/PavementScan/mobile.html',
  '/PavementScan/mobile.css',
  '/PavementScan/mobile.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
];

// Install — cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate — clear old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — cache-first for app shell, network-first for everything else
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Skip non-GET, Maps API calls, and proxy calls (always need network)
  if (e.request.method !== 'GET') return;
  if (url.includes('maps.googleapis.com') || url.includes('workers.dev') || url.includes('overpass-api.de')) return;

  // App shell — cache first
  if (APP_SHELL.some(s => url.endsWith(s) || url.includes(s))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        // Return cache, but fetch update in background
        const fetchUpdate = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchUpdate;
      })
    );
    return;
  }

  // Everything else — network first, fall back to cache
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
