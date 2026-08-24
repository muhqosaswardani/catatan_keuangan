# Fase 2 — Bagian 1 dari 5: Infrastruktur Notifikasi PWA (Push Notification)

## Cara pakai file ini
Ini bagian 1 dari 5 pengerjaan Fase 2 project KaslyAI (lihat file `konteks-catatan-keuangan.md` yang saya upload bareng file ini untuk akses repo GitHub & Supabase). Landing page promosi sudah selesai duluan, jadi tidak dikerjakan lagi. Kerjakan HANYA cakupan di bawah ini — jangan buka fitur bagian 2-5 dulu, itu menyusul di chat terpisah setelah bagian ini beres dan sudah saya tes.

## Kenapa bagian ini duluan
Bagian 2-5 semuanya butuh "jalur kirim notifikasi ke HP user" sudah berfungsi. Kalau infrastruktur push notification belum ada, transaksi dari WA/Transaksi AI Cepat nanti tidak ada cara untuk memberi tahu user. Jadi bagian ini adalah fondasi teknis, belum ada fitur yang user-facing secara penuh — outputnya lebih ke "pipa" yang nanti dipakai bagian selanjutnya.

## Tujuan Bagian Ini
Membangun infrastruktur agar aplikasi KaslyAI (index.html, PWA yang sudah di-install) bisa:
1. Minta izin notifikasi ke user & mendaftarkan device-nya (push subscription).
2. Menyimpan subscription itu ke Supabase, terkait ke akun user (per akun, bisa lebih dari 1 device).
3. Punya satu fungsi terpusat di backend (Supabase Edge Function) yang bisa dipanggil dari mana saja (webhook WA di bagian 3, Transaksi AI Cepat di bagian 2, dst) untuk **mengirim** push notification ke semua device milik satu akun.
4. Menerima aksi dari notifikasi (tombol Edit/Hapus/Lengkapi) walau app sedang tertutup, lewat service worker.

## Keputusan Teknis (ambil sendiri saat kerja, tidak mengubah PRD)
PRD menyebutkan ini belum diputuskan: pakai Web Push API murni atau lewat Firebase Cloud Messaging (FCM). Silakan pilih salah satu berdasarkan pertimbangan berikut, lalu jelaskan alasannya ke saya sebelum lanjut implementasi penuh:
- Web Push API murni (VAPID key, tanpa dependency pihak ketiga) — lebih ringan, tidak perlu akun Firebase, tapi kamu yang urus semua endpoint & VAPID key.
- Firebase Cloud Messaging — perlu bikin project Firebase terpisah (akan saya buatkan kalau dipilih), tapi delivery lebih matang & ada dashboard monitoring.

Kalau ragu, sarankan Web Push API murni dulu karena tidak nambah dependency akun baru, kecuali ada alasan kuat FCM lebih baik untuk kasus kita (banyak user Android/iPhone PWA).

## Cakupan Pekerjaan

### 1. Skema Database (Supabase)
Buat tabel baru untuk simpan push subscription per device per user, contoh struktur (sesuaikan nama kolom dengan konvensi tabel lain yang sudah ada di `schema.sql`):
- `id`, `user_id` (relasi ke akun/auth user), `endpoint`, `keys_p256dh`, `keys_auth`, `user_agent` (opsional, buat tau device apa), `created_at`.
- Satu akun boleh punya banyak baris (banyak device).
- Tambahkan RLS policy: user hanya bisa insert/select/delete baris miliknya sendiri (pakai `auth.uid()` atau kolom user_id yang sesuai skema auth yang sudah dipakai di project — cek dulu bagaimana user_id direferensikan di tabel-tabel lain).

### 2. Service Worker (index.html / file service worker terpisah)
- Tambahkan/perbarui service worker yang sudah ada (untuk PWA ini) supaya bisa:
  - Menerima event `push` → tampilkan notifikasi sesuai payload (title, body, actions berupa tombol).
  - Menerima event `notificationclick` → jalankan aksi sesuai tombol yang ditekan (untuk saat ini, cukup siapkan struktur umum: buka app ke URL tertentu berdasarkan data yang dikirim di payload — logic detail Edit/Hapus/Lengkapi baru diisi penuh di Bagian 2 & 3, tapi arsitektur routing-nya harus sudah siap dipakai di sini).
- Pastikan tidak merusak fungsi service worker yang sudah ada sekarang (kalau sudah ada untuk offline caching, dsb) — tambahkan, bukan mengganti total.

### 3. Alur Minta Izin & Subscribe (Frontend, index.html)
- Tambahkan momen yang wajar untuk minta izin notifikasi (jangan langsung muncul di pertama kali buka app — cari titik yang masuk akal, misal setelah onboarding selesai, atau di menu Pengaturan ada tombol "Aktifkan Notifikasi" kalau belum aktif).
- Begitu izin diberikan, generate push subscription dari browser lalu kirim & simpan ke tabel Supabase yang dibuat di poin 1.
- Kalau user menolak izin, jangan dipaksa/di-nagging terus-menerus — cukup ada indikator status di menu Pengaturan ("Notifikasi: Aktif" / "Notifikasi: Nonaktif, klik untuk aktifkan").
- Kalau user logout (sesuai alur logout di Fase 1), hapus/nonaktifkan subscription device itu dari database supaya tidak terus menerima notifikasi akun lama.

### 4. Edge Function Pengirim Notifikasi (Supabase)
Buat 1 Edge Function baru (misal nama `send-push-notification`) yang:
- Menerima parameter: `user_id` (akun tujuan), `title`, `body`, dan `data` (object bebas — dipakai nanti untuk info transaksi_id, tipe aksi, dll oleh bagian 2/3).
- Ambil semua push subscription milik `user_id` itu dari database.
- Kirim push notification ke semua device tersebut (pakai library web-push atau setara, sesuai keputusan Web Push API/FCM di atas).
- Fungsi ini akan DIPANGGIL oleh Edge Function lain di Bagian 2 & 3 (bukan dipanggil langsung dari browser) — desain sebagai fungsi internal/reusable.
- Tangani error dengan baik: kalau salah satu subscription sudah expired/invalid (device uninstall app dsb), hapus baris itu dari database secara otomatis, jangan sampai bikin seluruh proses gagal.

### 5. Testing Manual yang Perlu Kamu Siapkan
Sediakan cara sederhana buat saya coba, misal: tombol sementara/testing di menu Pengaturan "Kirim Notifikasi Uji Coba" yang manggil Edge Function `send-push-notification` dengan title/body contoh, supaya saya bisa pastikan notifikasi benar-benar muncul di HP saya sebelum lanjut ke bagian 2. Tombol ini boleh dihapus lagi nanti setelah semua bagian Fase 2 selesai & stabil (kasih komentar di kode supaya gampang ditemukan buat dihapus).

## Kriteria Selesai
- [ ] Tabel push subscription sudah ada di Supabase dengan RLS yang benar (user A tidak bisa lihat/hapus subscription user B).
- [ ] Service worker bisa menerima & menampilkan push notification dasar (title + body), termasuk saat app tertutup total.
- [ ] User bisa mengaktifkan notifikasi dari menu Pengaturan, status aktif/nonaktif terlihat jelas.
- [ ] Logout menghapus/menonaktifkan subscription device itu.
- [ ] Edge Function `send-push-notification` bisa dipanggil (via tombol uji coba) dan notifikasi benar-benar sampai ke HP.
- [ ] Tidak merusak fitur PWA/offline-sync yang sudah berjalan sekarang.

## Wajib Diikuti (dari konteks project)
- Setiap perubahan ke `index.html`, naikkan versi di `const version = '(vX.X.X)'` (fungsi `updateSyncStatusUI`), commit bareng kode dalam 1 commit, dan kabari saya versi berapa setelah push — sesuai aturan wajib di file konteks.
- Jangan taruh API key/secret apapun langsung di kode front-end (index.html/service worker) — kalau butuh key (VAPID private key, dsb), simpan di Supabase Edge Function secrets, bukan di browser.

## Setelah Bagian Ini Selesai
Saya akan tes dulu, lalu kirim ke kamu di chat baru: file konteks + file instruksi Bagian 2 (App Shortcuts & Transaksi AI Cepat) + prototype terkait, untuk lanjut membangun di atas fondasi ini.
