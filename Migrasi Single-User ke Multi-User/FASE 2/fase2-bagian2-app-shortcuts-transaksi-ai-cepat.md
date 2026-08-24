# Fase 2 — Bagian 2 dari 5: App Shortcuts & Transaksi AI Cepat

## Cara pakai file ini
Ini bagian 2 dari 5. Bagian 1 (infrastruktur notifikasi PWA — service worker, tabel subscription, Edge Function `send-push-notification`) SUDAH selesai dan sudah saya tes. Anggap semua itu sudah ada di project (cek langsung ke repo/database lewat akses di `konteks-catatan-keuangan.md`, jangan bangun ulang dari nol). Saya juga upload `prototype-menu-baru.html` — itu prototype TAMPILAN SAJA (belum ada fungsi/backend) untuk 2 layar yang jadi tugas kamu di bagian ini: Pintasan Home dan Transaksi AI Cepat. Pakai prototype itu sebagai acuan visual persis (warna, layout, teks, komponen), kamu tinggal sambungkan ke logic & data asli.

## Tujuan Bagian Ini
1. Menambahkan 2 App Shortcuts (tekan-lama ikon PWA di home screen): **Chat** dan **Transaksi AI**.
2. Membangun jalur baru **Transaksi AI Cepat** — beda dari fitur "Transaksi AI" yang sudah ada di halaman web (yang itu TIDAK BOLEH diubah sama sekali, tetap pakai alur lama: AI parsing → daftar hasil → tombol konfirmasi → baru tersimpan).
3. Jalur baru ini: user input (foto/teks/voice) → AI proses → **langsung tersimpan otomatis tanpa konfirmasi** → memicu push notification (pakai Edge Function `send-push-notification` dari Bagian 1) dengan tombol Edit/Hapus.

## Cakupan Pekerjaan

### 1. App Shortcuts (manifest.json)
- Tambahkan properti `shortcuts` di `manifest.json` PWA dengan 2 entry:
  - **Chat** → mengarah ke layar chat full-screen yang SUDAH ADA di aplikasi (fitur existing, jangan diubah sama sekali — cukup pastikan URL/route-nya bisa diakses langsung dari shortcut, misal `/?shortcut=chat` lalu di index.html ada logic buka langsung ke layar chat kalau parameter itu ada).
  - **Transaksi AI** → mengarah ke layar baru "Transaksi AI Cepat" (lihat poin 2), misal `/?shortcut=txai`.
- Icon untuk tiap shortcut boleh pakai icon app yang sama dulu kalau belum ada icon khusus, atau buatkan icon sederhana bertema jika memungkinkan.
- Pintasan ini HANYA bisa diakses lewat tekan-lama ikon PWA yang sudah di-install — tidak perlu ditambahkan entry point lain di dalam UI aplikasi (sesuai PRD, karena fitur Chat & Transaksi AI versi biasa sudah ada di web/menu utama).

### 2. Layar Transaksi AI Cepat (sesuai prototype `screen-txai-input`, `screen-txai-loading`, `screen-txai-saved`, `screen-txai-incomplete`, `screen-txai-saved-multi`)
Bangun layar full-screen baru (terpisah dari fitur "Transaksi AI" existing di web) dengan alur:
1. **Input** — user bisa ketik teks manual, upload/pilih foto (dari galeri/kamera), atau rekam voice note langsung di layar itu (ikuti komponen `ai-text-wrap`, `ai-choice-grid-camright`, `ai-mic-btn` di prototype).
2. **Proses** — kirim ke Gemini API (pakai cara/pola pemanggilan AI yang SUDAH ADA di aplikasi untuk fitur "Transaksi AI" existing — jangan bikin cara baru, supaya konsisten & tetap lewat Edge Function proxy kalau memang begitu cara existing-nya menyembunyikan API key. **Cek dulu di kode existing apakah pemanggilan Gemini untuk fitur AI sekarang sudah lewat Edge Function atau masih langsung dari browser** — kalau ternyata masih langsung dari browser pakai API key yang ikut terkirim, itu pelanggaran aturan keamanan di PRD/konteks project, laporkan ke saya dulu sebelum lanjut, jangan mencontoh pola yang salah itu).
3. **Tersimpan otomatis** — begitu AI selesai membaca, transaksi LANGSUNG tersimpan ke database (tanpa layar konfirmasi/tanpa tombol "Simpan" seperti fitur lama). Tampilkan layar hasil (sesuai `screen-txai-saved`).
4. **Data tidak lengkap** — kalau AI tidak berhasil membaca field wajib (misal nominal), JANGAN simpan penuh — simpan sebagai draf/belum lengkap, tampilkan layar `screen-txai-incomplete`, dan kirim notifikasi PWA varian "butuh dilengkapi" (lihat `screen-notif-pwa` bagian kedua di prototype) yang saat di-tap membuka layar edit dengan data yang sudah terbaca AI otomatis terisi.
5. **Multi kategori (1 input banyak kategori)** — kalau dari 1 struk/input ternyata AI mendeteksi lebih dari 1 kategori transaksi (misal struk belanja campuran), PECAH jadi beberapa transaksi terpisah, masing-masing tersimpan sendiri-sendiri, dan **masing-masing memicu notifikasi PWA sendiri-sendiri (bukan 1 notifikasi gabungan)** — supaya tiap transaksi bisa di-Edit/Hapus secara individual dari notifikasinya. Tampilan ringkasan multi-kategori di layar hasil ikuti `screen-txai-saved-multi`.

### 3. Notifikasi PWA untuk Transaksi AI Cepat
Setelah transaksi tersimpan (baik single maupun tiap item dari multi-kategori), panggil Edge Function `send-push-notification` (dari Bagian 1) dengan:
- Title: "Transaksi baru tercatat" (atau "Transaksi butuh dilengkapi" untuk kasus draf).
- Body: ringkasan kategori + nominal + dompet (contoh persis di prototype: `Pengeluaran · Galon + Token Listrik\nRp45.000 · Dompet Utama`).
- Data tambahan (`data` object) berisi minimal: `transaction_id`, `type` (misal `tx_saved` / `tx_incomplete`), dipakai service worker (dari Bagian 1) untuk menentukan aksi saat notifikasi di-tap atau tombol Edit/Hapus ditekan.
- Tombol aksi di notifikasi:
  - **Edit** → membuka aplikasi langsung ke layar edit transaksi tersebut.
  - **Hapus** → transaksi langsung terhapus dalam 1 tap dari notifikasi (tanpa buka app, tanpa pop up konfirmasi tambahan). Tapi begitu aplikasi dibuka lagi setelahnya, munculkan opsi singkat "Batalkan/Undo" untuk jaga-jaga kalau salah pencet (undo mengembalikan transaksi yang tadi dihapus, batasi window undo yang wajar, misal transaksi terakhir yang dihapus lewat notifikasi dalam sesi terakhir).
  - Untuk notifikasi "butuh dilengkapi": tombol **Lengkapi** (bukan Edit/Hapus) yang membuka layar edit dengan data yang sudah terbaca AI otomatis terisi, tanpa tombol hapus cepat (sesuai prototype).
- Tap badan notifikasi (bukan tombol) → membuka aplikasi ke halaman detail transaksi itu.

### 4. Tidak Boleh Diubah
- Fitur "Transaksi AI" existing di halaman web (alur lama: input → daftar hasil → konfirmasi → simpan) — sama sekali tidak berubah.
- Fitur "Chat" full-screen existing — tidak berubah, tetap tanpa notifikasi PWA (chat sudah punya cara koreksi sendiri lewat reply-edit di dalam chat itu sendiri, sesuai PRD).

## Kriteria Selesai
- [ ] Tekan-lama ikon PWA di home screen memunculkan 2 pintasan: Chat dan Transaksi AI, keduanya berfungsi membuka layar yang benar.
- [ ] Input teks/foto/voice note di Transaksi AI Cepat berhasil diproses AI dan tersimpan otomatis tanpa layar konfirmasi tambahan.
- [ ] Transaksi dengan data tidak lengkap (misal nominal kosong) tersimpan sebagai draf, notifikasi "butuh dilengkapi" muncul dan membuka layar edit dengan data terisi otomatis saat di-tap.
- [ ] Input dengan banyak kategori sekaligus terpecah jadi transaksi terpisah, masing-masing dengan notifikasi sendiri-sendiri.
- [ ] Tombol Edit & Hapus di notifikasi berfungsi sesuai deskripsi (Hapus 1 tap tanpa konfirmasi, ada Undo saat app dibuka lagi).
- [ ] Fitur Transaksi AI existing di web & fitur Chat full-screen tidak berubah perilakunya sama sekali.
- [ ] Pemanggilan AI di jalur baru ini tetap aman (tidak mengirim API key bersama/pribadi admin ke browser).

## Wajib Diikuti (dari konteks project)
- Naikkan versi `const version = '(vX.X.X)'` di `index.html` setiap ada perubahan/push, dalam commit yang sama, dan kabari saya versi terbaru setelah push.

## Setelah Bagian Ini Selesai
Saya tes dulu, lalu lanjut ke chat baru dengan: file konteks + file instruksi Bagian 3 (Webhook WhatsApp masuk & pemrosesan AI dari chat WA) + prototype/dokumen pendukung jika ada.
