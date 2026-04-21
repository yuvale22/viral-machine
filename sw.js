// sw.js — YUMi Service Worker v2
// Network-first: always fetch latest version, only cache for offline fallback

const CACHE_NAME = 'yumi-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // Always network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
