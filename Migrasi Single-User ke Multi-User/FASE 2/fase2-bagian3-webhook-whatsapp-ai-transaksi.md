# Fase 2 — Bagian 3 dari 5: Webhook WhatsApp Masuk & Pemrosesan AI Transaksi

## Cara pakai file ini
Ini bagian 3 dari 5. Bagian 1 (infrastruktur notifikasi PWA) dan Bagian 2 (App Shortcuts + Transaksi AI Cepat, termasuk logic simpan-otomatis & split multi-kategori) SUDAH selesai & sudah saya tes. Anggap semua fungsi itu sudah ada di project — cek langsung ke repo/database lewat akses di `konteks-catatan-keuangan.md`, JANGAN dibangun ulang, tapi DIPAKAI ULANG (reuse) sebisa mungkin, terutama logic simpan transaksi otomatis + split multi-kategori dari Bagian 2, dan Edge Function `send-push-notification` dari Bagian 1.

## Latar Belakang Singkat
Nomor WhatsApp resmi "KaslyAI" terhubung lewat WhatsApp Business Cloud API resmi dari Meta (bukan pihak ketiga). Nomor ini dipakai user untuk mengirim foto struk/teks/voice note sebagai input transaksi. Mulai 1 Oktober 2026, Meta mulai mengenakan biaya per pesan untuk BALASAN otomatis (termasuk dari AI) — makanya model interaksinya: WA murni jadi JALUR INPUT (selalu gratis, karena user yang inisiasi chat), dan sistem TIDAK WAJIB membalas lewat WA lagi untuk konfirmasi transaksi. Balasan/konfirmasi via WA baru dibahas detail di Bagian 4 (toggle per-user) — di bagian ini, KHUSUS untuk transaksi yang datanya sudah lengkap, anggap dulu semua user dalam kondisi "toggle OFF" (murni notifikasi PWA), supaya kita fokus dulu ke pipa WA masuk → tersimpan → notifikasi. Percabangan toggle ON/OFF lengkap menyusul di Bagian 4.

## Tujuan Bagian Ini
Membangun Edge Function/webhook yang menerima pesan masuk dari WhatsApp Business Cloud API di nomor resmi KaslyAI, lalu:
1. Mengidentifikasi nomor WA pengirim → cocokkan ke akun user yang sudah terverifikasi (dari Fase 1).
2. Mengambil isi pesan (foto/teks/voice note).
3. Memproses lewat Gemini API (server-side, lewat Edge Function — TIDAK BOLEH API key terekspos, ikuti pola aman yang sama seperti Bagian 2).
4. Menyimpan transaksi otomatis (reuse logic dari Bagian 2: simpan langsung, split kalau multi-kategori, tandai draf kalau data tidak lengkap).
5. Memicu notifikasi PWA (reuse Edge Function `send-push-notification` dari Bagian 1) untuk tiap transaksi yang tersimpan.

## Cakupan Pekerjaan

### 1. Setup Webhook WhatsApp Business Cloud API
- Buat Edge Function baru (misal `whatsapp-webhook`) yang jadi endpoint webhook untuk menerima pesan masuk dari Meta (verifikasi webhook token, handle `GET` untuk verification challenge Meta, dan `POST` untuk pesan masuk — ikuti dokumentasi resmi WhatsApp Business Cloud API Meta untuk format payload).
- Simpan credential yang dibutuhkan (access token WhatsApp Business API, phone number ID nomor resmi KaslyAI, verify token webhook) sebagai Supabase Edge Function secrets — JANGAN pernah taruh di kode/browser.
- Kalau saya belum kasih tahu detail credential WhatsApp Business API (access token, phone number ID, dsb), TANYAKAN ke saya dulu sebelum lanjut — jangan asumsikan atau pakai punya orang lain.

### 2. Identifikasi Akun dari Nomor Pengirim
- Ambil nomor WA pengirim dari payload webhook.
- Cocokkan ke tabel akun user (kunci akun = nomor WA terverifikasi, sesuai Fase 1).
- **Kalau nomor pengirim TIDAK terhubung ke akun manapun** (belum pernah verifikasi): abaikan pesan itu saja, tidak perlu dibalas otomatis (sesuai PRD).
- Kalau nomor cocok ke akun yang statusnya trial habis/belum bayar dan bukan pesan biasa (perintah AI): tangani sesuai Bagian 5 (fitur terkunci) — untuk bagian ini fokus dulu ke jalur akun yang masih aktif/trial berjalan.

### 3. Ambil & Proses Isi Pesan
Tangani 3 jenis input dari WA:
- **Teks** — ambil langsung isi pesan.
- **Foto** — download media dari WhatsApp Cloud API (pakai media ID dari payload → fetch URL media → download), lalu kirim ke Gemini sebagai gambar (vision).
- **Voice note** — download audio, transkripsi/proses lewat Gemini (cek kemampuan model Gemini yang dipakai project ini untuk audio input; kalau perlu, transkripsi dulu baru diproses sebagai teks — sesuaikan dengan cara yang paling reliable).

### 4. Deteksi Jenis Pesan: Transaksi vs Pertanyaan Umum vs Mode Terkunci
Pesan masuk lewat WA bisa berupa:
- **Input transaksi** (foto struk, "beli kopi 25rb", voice note nyebut pengeluaran, dll) → lanjut ke poin 5.
- **Pertanyaan umum** (misal "saldo saya berapa?", "total pengeluaran minggu ini?") → logic balasannya detail di Bagian 4 (tergantung toggle), tapi untuk bagian ini, siapkan dulu fungsi untuk MENDETEKSI bahwa pesan ini pertanyaan (bukan transaksi) dan bisa menghasilkan jawaban ringkas dari data user (misal query saldo/total transaksi) — jangan diimplementasikan pengiriman balasannya dulu (itu di Bagian 4), cukup pastikan hasil jawabannya sudah bisa dihasilkan dengan benar.
- **Perintah mode terkunci** (koreksi saldo, limit anggaran, tujuan tabungan — fitur existing percakapan multi-langkah via WA) — JANGAN DIUBAH cara kerja fitur existing ini. Untuk bagian ini, cukup pastikan webhook baru tidak merusak/menabrak fitur existing tersebut kalau memang sudah ada di sistem sekarang (cek dulu apakah fitur mode terkunci ini sudah berjalan lewat webhook WA yang sudah ada, atau ini yang pertama kali dibuat — kalau sudah ada sistem WA-bot lama, INTEGRASIKAN, jangan bikin 2 sistem webhook WA yang saling tabrakan).

### 5. Simpan Transaksi (Reuse Logic Bagian 2)
- Panggil ulang logic simpan-transaksi-otomatis yang sudah dibangun di Bagian 2 (jangan tulis ulang dari nol) — termasuk:
  - Simpan langsung kalau data lengkap.
  - Split jadi beberapa transaksi kalau AI mendeteksi lebih dari 1 kategori dari 1 input (misal struk belanja campuran).
  - Tandai sebagai draf/belum lengkap kalau ada field wajib yang tidak terbaca (misal nominal).
- Setelah tersimpan (atau jadi draf), panggil `send-push-notification` (Bagian 1) untuk tiap transaksi — SATU notifikasi PER transaksi, bukan digabung, sama seperti Bagian 2.

### 6. Migrasi Nomor WA Testing
Sesuai catatan di konteks project & PRD: nomor WA yang sekarang sudah dipakai untuk testing otomatis terhubung ke akun admin saat migrasi ke sistem baru ini — pastikan saat kamu deploy webhook ini, nomor testing yang sudah ada tidak jadi "nomor tak dikenal" yang pesannya diabaikan. Cek dulu status koneksi nomor itu di database sebelum anggap ini kasus baru.

## Kriteria Selesai
- [ ] Kirim foto struk ke nomor resmi KaslyAI dari nomor WA yang sudah terverifikasi → transaksi tersimpan otomatis, notifikasi PWA muncul dengan tombol Edit/Hapus yang berfungsi (reuse dari Bagian 1 & 2).
- [ ] Kirim teks transaksi (misal "makan siang 50rb") → hasil sama seperti di atas.
- [ ] Kirim voice note berisi transaksi → berhasil diproses & tersimpan.
- [ ] Kirim 1 struk berisi banyak kategori → terpecah jadi beberapa transaksi, masing-masing dapat notifikasi sendiri.
- [ ] Kirim data transaksi yang kurang lengkap (misal nominal tidak disebut) → tersimpan sebagai draf, notifikasi "butuh dilengkapi" muncul.
- [ ] Pesan dari nomor yang belum terverifikasi/tidak terhubung ke akun manapun → diabaikan, tidak ada balasan otomatis apapun.
- [ ] Fitur mode terkunci (koreksi/limit/tujuan) existing via WA (kalau sudah ada) tetap berjalan normal, tidak tertabrak oleh webhook baru ini.
- [ ] Tidak ada API key (Gemini/WhatsApp) yang terekspos ke browser atau ke kode front-end.

## Wajib Diikuti (dari konteks project)
- Naikkan versi `const version = '(vX.X.X)'` di `index.html` kalau ada perubahan di sana; kalau perubahan hanya di Edge Function (tidak menyentuh index.html), version bump tidak wajib untuk perubahan itu — tapi kalau ada penyesuaian index.html (misal UI status koneksi WA), tetap ikuti aturan bump versi.
- Simpan semua credential WhatsApp Business API di Supabase secrets, bukan di kode.

## Setelah Bagian Ini Selesai
Saya tes dulu (termasuk kirim pesan WA sungguhan), lalu lanjut ke chat baru dengan: file konteks + file instruksi Bagian 4 (Toggle "Balasan Otomatis WA" per user + percabangan logic lengkap ON/OFF).
