# Fase 2 — Bagian 4 dari 5: Toggle "Balasan Otomatis WA" & Percabangan Logic

## Cara pakai file ini
Ini bagian 4 dari 5. Bagian 1-3 (notifikasi PWA, Transaksi AI Cepat + App Shortcuts, webhook WA masuk + simpan transaksi otomatis) SUDAH selesai & sudah saya tes. Anggap semua sudah berjalan — cek langsung ke repo/database lewat akses di `konteks-catatan-keuangan.md`. Di Bagian 3 kita sengaja anggap dulu semua user "toggle OFF" (murni notifikasi PWA) supaya pipa dasarnya jalan dulu. **Bagian ini melengkapi semua percabangan ON/OFF yang PRD minta**, jadi baca cakupan di bawah pelan-pelan, ini bagian paling banyak percabangan logicnya di seluruh Fase 2.

## Tujuan Bagian Ini
1. Menambahkan toggle "Balasan Otomatis WA" di menu Pengaturan tiap user (pengaturan PER-USER, bukan pengaturan global admin).
2. Mengimplementasikan SEMUA percabangan logic berikut berdasarkan posisi toggle itu, untuk pesan yang masuk lewat webhook WA (yang sudah dibangun di Bagian 3).

## Cakupan Pekerjaan

### 1. UI Toggle di Menu Pengaturan
- Tambahkan toggle switch on/off, judul "Balasan Otomatis WA", dengan penjelasan singkat (contoh: "Saat aktif, KaslyAI akan tetap membalas di chat WhatsApp seperti biasa. Saat nonaktif, konfirmasi hanya lewat notifikasi di HP kamu.").
- Simpan nilai toggle per akun di database (kolom baru di tabel user/settings, default value: silakan pakai default ON untuk konsistensi dengan behavior lama, KECUALI kamu menemukan indikasi lain dari kode existing — laporkan default yang kamu pakai ke saya).
- Perubahan toggle harus langsung berlaku (tidak perlu save/reload manual berlebihan) untuk pesan WA berikutnya.

### 2. Percabangan: Transaksi Data LENGKAP
- **Toggle ON**: tidak berubah dari sebelumnya (dari Bagian 3) — transaksi tersimpan otomatis + notifikasi PWA tetap muncul. TAMBAHKAN: sistem JUGA mengirim balasan konfirmasi singkat lewat chat WA (contoh format: konfirmasi ringkas transaksi tersimpan, sesuaikan dengan style balasan WA yang sudah ada di sistem sebelumnya kalau ada).
- **Toggle OFF**: seperti yang sudah dibangun di Bagian 3 — hanya notifikasi PWA, TIDAK ADA balasan WA sama sekali untuk transaksi ini.

### 3. Percabangan: Transaksi Data TIDAK LENGKAP (misal nominal tidak disebut)
- **Toggle ON**: AI tetap menanyakan balik lewat chat WA seperti biasa (contoh: "Nominalnya berapa kak?"). Transaksi baru benar-benar tersimpan (bukan draf) SETELAH user menjawab lewat WA. Ini butuh logic percakapan multi-turn (simpan state "sedang menunggu jawaban field X untuk transaksi ini" per akun, supaya balasan user berikutnya di-attach ke transaksi yang sama, bukan dianggap pesan baru).
- **Toggle OFF**: seperti Bagian 3 — transaksi disimpan sebagai draf, notifikasi PWA "butuh dilengkapi" muncul, TIDAK ADA balasan tanya-balik lewat WA.

### 4. Percabangan: Pertanyaan Umum di Luar Transaksi (misal "saldo saya berapa?", "total pengeluaran minggu ini?")
- **Toggle ON**: AI jawab langsung lewat chat WA seperti biasa (balasan teks di WA).
- **Toggle OFF**: jawabannya TETAP DIKIRIM, tapi lewat notifikasi PWA berisi jawaban ringkas (contoh persis dari PRD: "💰 Saldo kamu: Rp 1.250.000"), BUKAN balasan WA. Reuse Edge Function `send-push-notification` dari Bagian 1 (notifikasi ini tidak butuh tombol aksi Edit/Hapus, cukup informatif — lihat mockup ketiga di `screen-notif-pwa` pada prototype Bagian 2 kalau masih ada aksesnya sebagai referensi visual).
- Catatan: fungsi untuk MENGHASILKAN jawaban ini (query saldo, total pengeluaran, dll) seharusnya sudah disiapkan di Bagian 3 poin 4 — di sini tinggal disambungkan ke percabangan pengiriman ON/OFF.

### 5. Percabangan: Fitur Mode Terkunci (koreksi saldo, limit anggaran, tujuan tabungan — percakapan multi-langkah existing)
- **Toggle ON**: fitur berjalan seperti biasa (tidak berubah dari sebelumnya, percakapan multi-langkah lewat WA seperti sekarang).
- **Toggle OFF**: fitur ini DINONAKTIFKAN TOTAL lewat WA (tidak diadaptasi ke notifikasi karena sifatnya percakapan panjang bolak-balik yang tidak cocok jadi notifikasi sekali kirim). Kalau user tetap coba ketik perintah terkait (misal 'koreksi', 'limit', 'tujuan') saat toggle OFF: JANGAN didiamkan — kirim notifikasi PWA yang mengarahkan user untuk pakai fitur ini langsung di aplikasi web (contoh isi: "Fitur ini perlu balasan WA aktif — nyalakan di pengaturan, atau pakai fitur ini langsung di aplikasi web").

### 6. Konsistensi Antar Percabangan
- Semua keputusan "kirim ke WA atau kirim ke notifikasi PWA" HARUS mengecek toggle user itu di setiap titik keputusan — jangan hardcode salah satu jalur. Sarannya: buat satu fungsi helper terpusat, misal `kirimBalasan(userId, pesan, opsiNotifPWA)` yang di dalamnya sendiri yang mengecek toggle dan memutuskan jalur mana yang dipakai — supaya konsisten dan gampang di-maintain, dipakai di semua Edge Function terkait WA (webhook Bagian 3, dan bagian mode terkunci/pertanyaan umum di atas).

## Kriteria Selesai (persis kriteria di PRD untuk bagian ini)
- [ ] Toggle "Balasan Otomatis WA" di setting user berfungsi dan tersimpan per akun.
- [ ] Kirim data transaksi tidak lengkap: toggle ON → AI menanyakan balik lewat WA; toggle OFF → transaksi masuk sebagai draf + notifikasi "butuh dilengkapi".
- [ ] Tanya hal umum (misal saldo) lewat WA saat toggle OFF: jawaban ringkas muncul lewat notifikasi PWA, bukan balasan WA. Saat toggle ON: balasan tetap via WA.
- [ ] Coba masuk mode terkunci (koreksi/limit/tujuan) lewat WA saat toggle OFF: fitur tidak berjalan, notifikasi PWA muncul mengarahkan ke web. Saat toggle ON: fitur berjalan normal seperti sebelumnya.
- [ ] Transaksi data lengkap: toggle ON dapat balasan WA + notifikasi PWA; toggle OFF hanya notifikasi PWA.
- [ ] Mengubah toggle langsung berlaku untuk pesan WA berikutnya tanpa perlu logout/reload aplikasi.

## Wajib Diikuti (dari konteks project)
- Naikkan versi `const version = '(vX.X.X)'` di `index.html` untuk perubahan UI toggle di Pengaturan, dalam commit yang sama dengan kode, dan kabari saya versi terbaru.

## Setelah Bagian Ini Selesai
Saya tes dulu (termasuk coba semua kombinasi ON/OFF), lalu lanjut ke chat baru dengan: file konteks + file instruksi Bagian 5 (Fitur AI terkunci via WA saat trial habis, ganti nomor HP, dan pengetesan menyeluruh Fase 2).
