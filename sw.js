// KaslyAI Service Worker
// Strategi: app-shell cache-first untuk file statis (index.html, manifest, ikon),
// network-first untuk request lain (supaya data Supabase selalu fresh saat online).
// Data transaksi sendiri sudah ditangani offline-first lewat localStorage di dalam index.html —
// service worker ini hanya menjaga APLIKASINYA (bukan datanya) tetap bisa dibuka tanpa internet.

const CACHE_VERSION = 'kaslyai-v3.6.47';
const SCOPE_URL = new URL('./', self.location.href).href;
const APP_SHELL = [
  SCOPE_URL,
  new URL('index.html', SCOPE_URL).href,
  new URL('manifest.json', SCOPE_URL).href,
  new URL('chat.html', SCOPE_URL).href,
  new URL('chat-manifest.json', SCOPE_URL).href,
  new URL('icons/icon-192.png', SCOPE_URL).href,
  new URL('icons/icon-512.png', SCOPE_URL).href,
  new URL('icons/icon-badge-96.png', SCOPE_URL).href,
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

// ============================================================
// Fase 2 Bagian 1: Push Notification
// ============================================================

// Terima push dari server (dikirim lewat Edge Function send-push-notification)
// dan tampilkan sebagai notifikasi sistem, termasuk saat app tertutup total.
self.addEventListener('push', (event) => {
  let payload = { title: 'KaslyAI', body: 'Ada update baru.', data: {} };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    // fallback kalau payload bukan JSON valid
    if (event.data) payload.body = event.data.text();
  }

  const options = {
    body: payload.body,
    icon: new URL('icons/icon-192.png', SCOPE_URL).href,
    // badge WAJIB pakai versi monokrom (siluet putih alpha-only, background transparan) —
    // Android me-mask badge jadi alpha-only, jadi kalau dikasih PNG berwarna solid (seperti
    // icon-192 biasa yang backgroundnya opaque), hasilnya cuma kotak siluet polos tanpa bentuk.
    badge: new URL('icons/icon-badge-96.png', SCOPE_URL).href,
    data: payload.data || {},
    // actions diisi kalau payload.data.actions ada (dipakai Bagian 2/3 untuk
    // tombol Edit/Hapus/Lengkapi langsung dari notifikasi)
    actions: Array.isArray(payload.data?.actions) ? payload.data.actions : [],
    tag: payload.data?.tag || undefined,
    renotify: !!payload.data?.tag,
    // Getar + requireInteraction: sinyal ke Android supaya notifikasi lebih
    // mungkin muncul sebagai heads-up/mengambang (bukan cuma masuk bar atas).
    // Catatan: tampilan mengambang akhirnya tetap ditentukan oleh setelan
    // "importance"/"pop on screen" channel notifikasi Chrome untuk situs ini
    // di sisi Android — kalau masih belum mengambang meski sudah ini,
    // arahkan user ke: Setelan Android > Aplikasi > Chrome > Notifikasi >
    // (nama situs KaslyAI) > pastikan levelnya "Urgent"/"Pop on screen".
    vibrate: payload.data?.vibrate || [200, 100, 200],
    requireInteraction: !!payload.data?.requireInteraction,
    silent: false,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// Terima klik pada notifikasi (termasuk klik tombol aksi) dan arahkan ke URL
// yang sesuai. Struktur routing umum disiapkan di sini; logic detail per
// aksi (Edit/Hapus/Lengkapi) diisi penuh di Bagian 2 & 3 lewat payload.data.
// Fase 2 Bagian 2: tombol "Hapus" di notifikasi transaksi harus menghapus transaksi
// SAAT ITU JUGA tanpa membuka app (beda dari aksi lain yang menavigasi ke app).
// Dilakukan langsung dari sini via REST Supabase (anon key publishable, aman ada di
// service worker — sama seperti sudah ada di index.html), lalu recalculate saldo
// dompet dari total transaksi yang tersisa (bukan cuma delta) biar tetap akurat.
// Snapshot transaksi yang dihapus disimpan ke user_settings.last_notif_deleted supaya
// index.html bisa menawarkan "Undo" saat app dibuka lagi.
const SUPABASE_URL = 'https://qdoduglbejcazjufvfkf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QKdAJuIR4ue_tU4yQPvCmQ_3O1_0IGy';

async function handleDeleteFromNotification(data) {
  const { transaction_id: txId, user_id: userId } = data;
  if (!txId) return;

  try {
    // Panggil Edge Function delete-transaction yang memiliki service role key (bypass RLS secara aman)
    const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ transaction_id: txId, user_id: userId })
    });

    const result = await res.json();
    if (!res.ok && !result.success) {
      console.warn('[sw] delete-transaction response not ok:', result);
      return;
    }

    const noteName = result.note || 'Transaksi';

    // 1. Kirim pesan ke semua window app yang terbuka agar transaksi terhapus secara real-time di UI
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      client.postMessage({ type: 'NOTIF_TRANSACTION_DELETED', txId });
    }

    // 2. Berikan notifikasi konfirmasi bahwa transaksi berhasil dihapus
    self.registration.showNotification('Transaksi dihapus', {
      body: noteName + ' telah terhapus dari catatan.',
      icon: new URL('icons/icon-192.png', SCOPE_URL).href,
      tag: 'txai-delete-confirm',
    });
  } catch (e) {
    console.error('[sw] error handleDeleteFromNotification:', e);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const action = event.action; // '' kalau klik body notifikasi (bukan tombol aksi)

  // DEBUG SEMENTARA (khusus notif uji coba dari Pengaturan > Kirim Notifikasi Uji Coba):
  // tampilkan notif baru yang isinya persis action string yang diterima SW, supaya
  // kelihatan apakah browser beneran ngirim 'edit' saat tombol Edit ditekan, atau
  // malah ngirim sesuatu yang lain. Tidak mempengaruhi alur asli (delete/edit tetap jalan
  // seperti biasa di bawah), cuma nambah 1 notif info.
  if (data.type === 'test_edit_button') {
    self.registration.showNotification('DEBUG: notificationclick', {
      body: 'event.action diterima = "' + action + '"',
      icon: new URL('icons/icon-192.png', SCOPE_URL).href,
      tag: 'txai-debug-action',
    });
  }

  if (action === 'hapus' || action === 'delete') {
    event.waitUntil(handleDeleteFromNotification(data));
    return;
  }

  // targetUrl ditentukan oleh pengirim notifikasi lewat payload.data:
  let targetPath = './?shortcut=edit-tx&id=' + encodeURIComponent(data.transaction_id || '');
  if (action && data.actionUrls && data.actionUrls[action]) {
    targetPath = data.actionUrls[action];
  } else if (data.url) {
    targetPath = data.url;
  }
  const targetUrl = new URL(targetPath, SCOPE_URL).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      // 1. Cari client window yang sudah terbuka di scope ini
      for (const client of clientList) {
        if ('focus' in client) {
          try {
            client.postMessage({
              type: 'NOTIF_OPEN_EDIT',
              url: targetUrl,
              transaction_id: data.transaction_id
            });
            return await client.focus();
          } catch (e) {
            console.warn('[sw] client.focus error:', e);
          }
        }
      }
      // 2. Jika belum ada window terbuka, buka window baru
      if (self.clients.openWindow) {
        return await self.clients.openWindow(targetUrl);
      }
    }).catch(async (err) => {
      console.error('[sw] notificationclick error, fallback openWindow:', err);
      if (self.clients.openWindow) {
        return await self.clients.openWindow(targetUrl);
      }
    })
  );
});
