// KaslyAI Service Worker
// Strategi: app-shell cache-first untuk file statis (index.html, manifest, ikon),
// network-first untuk request lain (supaya data Supabase selalu fresh saat online).
// Data transaksi sendiri sudah ditangani offline-first lewat localStorage di dalam index.html —
// service worker ini hanya menjaga APLIKASINYA (bukan datanya) tetap bisa dibuka tanpa internet.

const CACHE_VERSION = 'kaslyai-v1';
const SCOPE_URL = new URL('./', self.location.href).href;
const APP_SHELL = [
  SCOPE_URL,
  new URL('index.html', SCOPE_URL).href,
  new URL('manifest.json', SCOPE_URL).href,
  new URL('icons/icon-192.png', SCOPE_URL).href,
  new URL('icons/icon-512.png', SCOPE_URL).href,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Jangan campur tangan request non-GET (POST/PUT ke Supabase dll) atau request lintas-origin (API pihak ketiga)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Navigasi halaman (buka app langsung, termasuk lewat URL dengan query seperti ?akses=... atau ?source=pwa):
  // cache-first ke index.html, abaikan query string saat mencocokkan ke cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE_VERSION).then((cache) => cache.put(APP_SHELL[1], res.clone()));
          return res;
        })
        .catch(() =>
          caches.match(APP_SHELL[1], { ignoreSearch: true }).then((cached) => cached || caches.match(APP_SHELL[0]))
        )
    );
    return;
  }

  // App shell (manifest, ikon, dll): cache-first (biar tetap bisa dibuka offline / koneksi jelek)
  if (APP_SHELL.includes(req.url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Selain itu: network-first, fallback ke cache kalau offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
