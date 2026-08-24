# Fase 2 — Bagian 5 dari 5: Fitur AI Terkunci, Edge Case, & QA Menyeluruh

## Cara pakai file ini
Ini bagian terakhir (5 dari 5) dari Fase 2. Bagian 1-4 (notifikasi PWA, Transaksi AI Cepat + App Shortcuts, webhook WA + simpan transaksi, toggle Balasan Otomatis WA + semua percabangan ON/OFF) SUDAH selesai & sudah saya tes. Anggap semua sudah berjalan — cek langsung ke repo/database lewat akses di `konteks-catatan-keuangan.md`. Bagian ini menutup sisa item Fase 2 yang belum tersentuh di bagian 1-4, plus jadi sesi QA menyeluruh sebelum Fase 2 dianggap benar-benar selesai (Fase 3 — trial/token/dashboard admin — menyusul di chat terpisah lain waktu).

## Cakupan Pekerjaan

### 1. Fitur AI Terkunci via WA (trial habis / belum bayar)
- Kalau user mengirim perintah AI lewat WhatsApp (transaksi, pertanyaan, atau mode terkunci) TAPI status akunnya sedang trial habis dan belum ada token yang dimasukkan (fitur AI seharusnya terkunci):
  - **Toggle "Balasan Otomatis WA" milik user itu ON**: beri tahu lewat balasan WA bahwa fitur sedang terkunci, dan arahkan untuk menghubungi admin.
  - **Toggle OFF**: pemberitahuan itu dikirim lewat notifikasi PWA saja (reuse `send-push-notification`), bukan balasan WA, isinya tetap mengarahkan untuk menghubungi admin/berlangganan.
- Catatan: kalau sistem trial/token dari Fase 3 belum ada sama sekali di database (Fase 3 belum dikerjakan), buat kolom/flag status akun sederhana dulu untuk keperluan testing bagian ini saja (misal kolom `ai_locked boolean default false` di tabel user), supaya kamu bisa mengetes skenario "terkunci" secara manual. Jangan bangun sistem trial/token penuh di sini — itu scope Fase 3 terpisah, cukup siapkan titik pengecekannya saja supaya nanti tinggal disambungkan.
- Pastikan titik pengecekan status terkunci ini dipasang di SEMUA jalur AI: webhook WA (Bagian 3), Transaksi AI Cepat (Bagian 2), dan fitur Transaksi AI existing di web — supaya nanti begitu Fase 3 mengisi logic trial sungguhan, semua jalur otomatis ikut terkunci tanpa perlu ubah lagi titik-titik ini.

### 2. Ganti Nomor HP / Reconnect Nomor WA
- Sesuai PRD: kalau user ganti nomor HP dan mau tetap pakai akun yang sama, penyambungan ulang ke nomor baru HARUS lewat admin (reset manual). Untuk bagian ini, siapkan STRUKTUR datanya saja di sisi user-facing (misal: kalau nomor WA akun itu di-reset oleh admin — fitur reset ini sendiri baru dibangun penuh di dashboard admin Fase 3 — maka begitu user kirim pesan dari nomor manapun, sistem harus bisa mendeteksi "nomor ini sudah tidak terhubung ke akun manapun lagi" dan pesan diabaikan, sesuai perilaku nomor tak dikenal biasa). Jangan bangun UI reset di sisi admin di sini (itu Fase 3), cukup pastikan efek sampingnya di sisi webhook WA sudah benar kalau suatu saat status koneksi nomor itu diubah manual langsung lewat database (untuk testing, kamu boleh coba ubah manual lewat SQL di Supabase untuk simulasi reset).

### 3. Pesan dari Nomor Tak Dikenal
- Pastikan (cross-check ulang dari Bagian 3): pesan WA masuk dari nomor yang belum pernah terverifikasi/terhubung ke akun manapun benar-benar diabaikan sepenuhnya, tidak ada balasan otomatis dalam bentuk apapun (WA maupun notifikasi PWA, karena tidak ada akun tujuan notifikasi).

### 4. QA Menyeluruh — Jalankan Semua Kriteria Selesai Fase 2 dari PRD
Sebelum bilang Fase 2 selesai, jalankan & pastikan SEMUA ini lolos (gabungan dari seluruh bagian 1-5):
- [ ] Kirim foto struk/teks/voice note ke WA resmi KaslyAI: transaksi langsung tersimpan otomatis dan notifikasi PWA muncul dengan tombol Edit/Hapus yang berfungsi.
- [ ] Tombol Hapus di notifikasi berhasil menghapus transaksi dalam 1 tap, opsi undo muncul begitu aplikasi dibuka berikutnya.
- [ ] Toggle "Balasan Otomatis WA" berfungsi: ON tetap dapat balasan WA, OFF cuma dapat notifikasi PWA saja — untuk SEMUA jenis pesan (transaksi lengkap, transaksi tidak lengkap, pertanyaan umum, mode terkunci).
- [ ] Kirim data transaksi tidak lengkap: toggle ON → AI tanya balik via WA; toggle OFF → draf + notifikasi "butuh dilengkapi".
- [ ] Tanya hal umum (misal saldo) saat toggle OFF: jawaban ringkas via notifikasi PWA.
- [ ] Coba mode terkunci (koreksi/limit/tujuan) saat toggle OFF: fitur tidak jalan, notifikasi arahkan ke web; saat ON: jalan normal seperti sebelumnya.
- [ ] Pesan/notifikasi fitur AI terkunci (simulasi trial habis) muncul sesuai posisi toggle user (WA kalau ON, notifikasi PWA kalau OFF).
- [ ] Pintasan "Chat" dan "Transaksi AI" di home screen berfungsi sesuai alurnya masing-masing.
- [ ] Input dengan banyak kategori sekaligus dari 1 struk/pesan terpecah jadi beberapa transaksi terpisah dengan notifikasi masing-masing.
- [ ] Fitur Transaksi AI existing di web dan fitur Chat full-screen tidak berubah perilakunya dari sebelum Fase 2 dikerjakan.
- [ ] Pesan dari nomor tak dikenal diabaikan total, tidak ada balasan/notifikasi apapun.
- [ ] Tidak ada API key (Gemini maupun WhatsApp Business API) yang bisa diintip lewat inspect browser di manapun.

### 5. Rapikan Sisa Pekerjaan Testing
- Hapus/nonaktifkan tombol-tombol testing sementara yang dibuat di Bagian 1 (misal tombol "Kirim Notifikasi Uji Coba") kalau sudah tidak diperlukan lagi, ATAU beri catatan jelas di kode kalau kamu memilih tetap menyimpannya untuk keperluan debugging ke depan.
- Rapikan flag/kolom sementara yang dipakai untuk simulasi trial (`ai_locked` dsb dari poin 1) — beri komentar jelas di schema bahwa kolom ini akan disambungkan penuh ke sistem trial/token asli di Fase 3, supaya tidak bingung nanti.

## Wajib Diikuti (dari konteks project)
- Naikkan versi `const version = '(vX.X.X)'` di `index.html` untuk setiap perubahan, dalam commit yang sama, dan kabari saya versi terbaru setelah push.

## Setelah Bagian Ini Selesai
Fase 2 (di luar landing page yang sudah lebih dulu jadi) dianggap selesai penuh. Fase 3 (Trial, Token, Pembayaran, Dashboard Admin) akan saya siapkan instruksinya terpisah di chat lain kalau sudah siap dikerjakan.
