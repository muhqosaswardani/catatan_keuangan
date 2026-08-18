# PROMPT KERJA — Migrasi KaslyAI: Single-User → Multi-User (PWA)

> Dokumen ini adalah instruksi kerja untuk agentic coding tool (Antigravity IDE / setara).
> Bacalah seluruh isi dokumen ini dulu sampai habis sebelum menyentuh kode apapun.
> Ikuti urutan fase secara berurutan — jangan lompat ke fase berikutnya sebelum "Kriteria Selesai" fase sebelumnya terpenuhi.

---

## 0. Konteks & Peran Kamu

Kamu sedang mengerjakan migrasi aplikasi **KaslyAI** (nama produk — sebelumnya disebut "Catatan Keuangan") dari aplikasi single-user (satu kode akses dipakai bersama, tanpa pemisahan kepemilikan) menjadi aplikasi multi-user berbasis PWA, dengan login berbasis nomor WhatsApp, fitur AI (Gemini) berbayar (trial + token lifetime), integrasi AI lewat chat WhatsApp, notifikasi push PWA, dan dashboard admin.

**Dokumen sumber kebenaran (source of truth) untuk requirement:** `PRD-Catatan-Keuangan-MultiUser.md` (v2.6) — ada di root project. **Semua keputusan produk, copywriting, aturan bisnis, dan kriteria selesai WAJIB mengikuti isi PRD ini secara harfiah.** Kalau ada bagian di prompt ini yang terasa kurang jelas atau tampak bertentangan dengan PRD, PRD yang menang — dan kamu harus berhenti lalu bertanya ke user, jangan menebak.

### File-file yang terlibat, dan perannya masing-masing

| File | Status | Peran |
|---|---|---|
| `index.html` | **Aplikasi produksi yang sedang berjalan.** Single file besar (~18.000 baris — HTML+CSS+JS jadi satu), sudah terhubung ke Supabase, sudah punya modul wallet/transaksi/kategori/anggaran/tabungan/utang/recurring/chat AI/laporan, dll. | Ini yang akan **kamu ubah/kembangkan**. Semua fitur existing di dalamnya **tidak boleh rusak atau dihapus** kecuali memang diminta PRD (misal mekanisme `access_code` bersama harus diganti jadi akun per-user). |
| `prototype-flow.html` | Prototipe UI **final & disetujui** untuk alur Fase 1 (promo → daftar → verifikasi WA → onboarding → setup dompet & kategori) + beberapa modal terkait (trial habis, API key, dsb). | **Acuan tampilan wajib untuk Fase 1.** Jangan didesain ulang — ambil markup, style, komponen, dan interaksinya, sesuaikan ke arsitektur `index.html`, sambungkan ke Supabase sungguhan (di prototipe ini semua masih dummy/simulasi front-end saja). |
| `prototype-menu-baru.html` | Prototipe UI **final & disetujui** untuk alur Fase 2 (App Shortcuts "Chat" & "Transaksi AI" lewat home screen PWA, layar transaksi AI cepat, layar notifikasi PWA dengan tombol Edit/Hapus). | **Acuan tampilan wajib untuk Fase 2.** Sama seperti di atas — logic sungguhan (push notification, simpan-otomatis, dsb) belum ada di sini, itu tugasmu membangunnya, tampilannya jangan diubah kecuali ada alasan teknis kuat. |
| `admin-dashboard.html` | Prototipe UI **final & disetujui** untuk dashboard admin (3 tab: Pengguna, Kode Token, Pengaturan). | **Acuan tampilan wajib untuk Fase 3.** Saat ini di prototipe ini kemungkinan belum ada Supabase Auth sungguhan / RLS sungguhan — kamu yang menambahkannya sesuai bagian 3 & 3b PRD (keamanan). |
| `PRD-Catatan-Keuangan-MultiUser.md` | Dokumen requirement. | Sudah dijelaskan di atas — **acuan utama segalanya.** |

### Prinsip kerja penting

1. **Jangan redesign UI dari nol.** Ketiga file prototipe sudah final secara visual/UX — tugasmu adalah *mengkabelkan* (wiring) prototipe itu ke logic sungguhan (Supabase, Auth, Edge Functions, dsb), bukan mendesain ulang tampilannya. Kalau kamu merasa ada bagian UI prototipe yang perlu diubah demi kebutuhan teknis, itu boleh, tapi minimal dulu dan beri catatan kenapa.
2. **`index.html` tetap jadi 1 file utama aplikasi user** (boleh dipecah jadi beberapa file kalau itu keputusan arsitektur yang kamu ambil dan masuk akal, tapi cek dulu apakah project ini punya batasan hosting GitHub Pages static — lihat bagian 3 PRD, "1 repository, 2 link/path berbeda" untuk index vs admin dashboard).
3. **Satu Supabase project** dipakai bersama oleh index (app user) dan dashboard admin (lihat PRD bagian 3).
4. **API key Gemini (bersama & pribadi admin) TIDAK BOLEH pernah dikirim ke browser.** Ini adalah requirement keamanan keras dari PRD bagian 3b — wajib lewat Supabase Edge Function sebagai perantara. Kalau kamu menemukan kode existing di `index.html` yang memanggil Gemini API langsung dari browser dengan key tertanam/diambil ke client, itu WAJIB direfactor jadi lewat Edge Function sebagai bagian dari migrasi ini (jangan dibiarkan, karena sekarang API key akan jadi milik banyak user berbeda + key bersama admin, resikonya jauh lebih besar dari sebelumnya).
5. **Baca dulu kode existing sebelum menulis kode baru.** `index.html` sudah punya pola-pola yang mapan (lihat bagian 1 di bawah) — ikuti pola yang sudah ada (penamaan variabel, cara panggil Supabase, cara render UI, dsb) supaya konsisten, jangan bikin pola baru yang bersaing.
6. Kalau ketemu keputusan teknis yang **tidak** dijawab PRD (PRD bagian 8 sudah menandai beberapa: teknis push notification FCM vs Web Push API native, dsb) — ambil keputusan yang paling sederhana & maintainable, catat alasannya di komentar kode / commit message, lanjut jalan. Jangan berhenti nunggu approval untuk hal-hal level implementasi teknis murni.
7. Kalau ketemu keputusan yang **menyangkut requirement produk/bisnis/keamanan** yang PRD tidak jawab — **stop, tanya ke user.**

---

## 1. Analisis Wajib Sebelum Mulai (Fase 0)

Sebelum menulis kode apapun, lakukan audit terhadap `index.html` dan laporkan temuanmu (boleh dalam bentuk ringkasan ke user atau file catatan `MIGRATION-NOTES.md`) untuk hal-hal berikut — karena ini semua akan berubah total di migrasi ini:

- **Mekanisme akses saat ini**: cari pola `access_code` (localStorage key `catatan_keuangan_access_code`, query param `?akses=` / `?access_code=`). Ini adalah pengganti "akun" yang lama — satu kode dipakai bersama, tanpa Supabase Auth sungguhan. Semua tabel Supabase (`wallets`, `transactions`, `categories`, `budgets`, `savings_goals`, `debt_entries`, `recurring_items`, `user_settings`) di-filter pakai kolom `access_code`, bukan `user_id`.
- **Rencana migrasi skema data**: PRD bagian 3b & Fase 1 minta isolasi data di **level penyimpanan** (bukan cuma tampilan) — artinya kamu perlu Row Level Security (RLS) Supabase yang sungguhan berbasis identitas user terverifikasi (nomor WA), bukan sekadar filter `.eq('access_code', code)` di client (itu tidak aman — user yang paham teknis bisa ganti nilai `access_code` di localStorage/URL dan intip data orang lain). Rencanakan:
  - Tabel baru: `users` (nomor WA terverifikasi sebagai kunci akun, nama, status trial/lifetime, token yang dipakai, dsb — lihat kolom yang dibutuhkan dari kriteria selesai Fase 3).
  - Ubah kolom `access_code` di semua tabel data existing menjadi `user_id` yang merujuk ke akun user terverifikasi (atau tetap pakai nomor WA sebagai kunci, sesuai keputusanmu — PRD bilang "kunci akun = nomor WA terverifikasi").
  - RLS policy per tabel: user hanya boleh baca/tulis baris miliknya sendiri. Dashboard admin butuh jalur baca lintas-user lewat Edge Function khusus yang mengecek sesi admin dulu (lihat PRD 3b, baris terakhir).
  - **Data existing (punya pemilik aplikasi sekarang, dipakai untuk testing)**: migrasikan jadi milik akun admin sendiri sebagai user pertama (PRD Fase 1, baris "Migrasi nomor WA existing").
- **Pola pemanggilan Gemini AI existing**: telusuri semua tempat di `index.html` yang memanggil Gemini (chat AI, parsing transaksi, insight otomatis, dsb — ini disebutkan di memori project: "AI transaction parsing improvements", "automatic AI insight feature"). Petakan semua titik ini karena semuanya perlu direfactor untuk: (a) lewat Edge Function (poin keamanan di atas), (b) pakai key milik user sendiri dulu baru fallback ke key bersama, sesuai prioritas di PRD.
- **Struktur navigasi/tab existing** di `index.html` — supaya kamu tahu di mana menyisipkan menu setting baru (toggle Balasan Otomatis WA, kelola API key per-akun, tombol Keluar/logout, input kode token).

Setelah audit ini, baru lanjut Fase 1.

---

## 2. FASE 1 — Pendaftaran, Verifikasi WhatsApp & Onboarding

**Acuan tampilan:** `prototype-flow.html` (screens: `screen-promo`, `screen-daftar`, `screen-verifikasi`, `screen-intro` [carousel 4 slide], `screen-api-guide`, `screen-dompet`, `screen-kategori`, plus modal `modalTrialHabis`, `modalApiKey`, `modalSyarat`, `modalKebijakan`, dll).

**Tujuan:** Ganti mekanisme `access_code` bersama dengan akun sungguhan berbasis nomor WhatsApp terverifikasi, dan alur onboarding lengkap sebelum masuk ke `index.html` (aplikasi utama).

### Tugas

1. **Skema database** (Supabase):
   - Buat tabel `users`: minimal `id`, `nama`, `nomor_wa` (unik, ter-normalisasi format), `status_verifikasi`, `trial_mulai_at`, `trial_lama_hari` (default ambil dari pengaturan admin), `token_dipakai` (nullable, relasi ke tabel token), `sumber_ai` (`'gratis'` / `'sendiri'`), `balasan_otomatis_wa` (boolean, default sesuai keputusan produk — cek PRD apakah ada default eksplisit, kalau tidak ada tanya user), `is_admin` (boolean), `created_at`, `last_active_at`.
   - Buat tabel `verifikasi_wa`: kode 20 karakter (huruf besar-kecil + angka, hindari `0/O`, `1/l/I`), nomor WA yang didaftarkan, status, `expires` tidak ada batas waktu (PRD: berlaku selamanya sampai dipakai) tapi tetap simpan `created_at` untuk audit.
   - Ubah semua tabel data (`wallets`, `transactions`, `categories`, `budgets`, `savings_goals`, `debt_entries`, `recurring_items`, `user_settings`) dari kunci `access_code` → kunci `user_id` (FK ke `users.id`).
   - Aktifkan **RLS** di semua tabel ini berbasis sesi user yang login (lihat poin autentikasi di bawah — karena login bukan Supabase Auth email/password biasa, tapi verifikasi custom berbasis WA, rencanakan mekanisme sesi yang tetap bisa dipetakan ke RLS, misal pakai Supabase Auth anonymous/custom session + custom claim `user_id`, atau JWT custom yang divalidasi via Edge Function — pilih pendekatan yang paling stabil, dokumentasikan keputusanmu).

2. **Layar Promo/Welcome** (`screen-promo` di prototipe): pindahkan sebagai entry point baru sebelum `index.html` menampilkan aplikasi utama. Tombol "Coba Aplikasinya, Gratis" → lanjut ke layar daftar. Tombol "Chat Admin" → buka WA ke nomor pribadi/bisnis admin (ambil dari `user_settings`/tabel pengaturan admin, jangan hardcode kalau memungkinkan).

3. **Layar Daftar** (`screen-daftar`): form Nama Lengkap + Nomor WhatsApp Aktif + checkbox S&K + Kebijakan Privasi (WAJIB dicentang sebelum tombol "Lanjutkan & Verifikasi via WhatsApp" aktif — cek ulang logic ini di prototipe, replikasikan). Sebelum generate kode verifikasi, cek dulu apakah nomor WA ini **sudah pernah terverifikasi sebelumnya** → kalau ya, skip ke alur "nomor sudah terdaftar" (langsung ke menu utama, skip seluruh onboarding, lihat PRD baris terkait "Login ulang setelah logout").

4. **Layar Verifikasi WA** (`screen-verifikasi`): generate kode 20 karakter, simpan ke tabel `verifikasi_wa`, buka deep-link WhatsApp (`https://wa.me/<nomor_resmi_kaslyai>?text=<pesan terisi>`) dengan format pesan persis sesuai PRD: `"Verifikasi KaslyAI, Kode: [kode]"`. Sistem harus punya jalur **menerima pesan masuk WA** (webhook dari provider WA Business API — PRD tidak menyebut provider spesifik, ini keputusan teknis yang perlu kamu ambil atau tanyakan ke user kalau belum ada provider yang dipakai) untuk mencocokkan 3 hal: kode, nomor terdaftar, nomor pengirim.
   - **Cek dulu**: apakah project ini sudah punya integrasi WhatsApp Business API/webhook existing (mungkin dipakai untuk fitur chat AI yang sudah ada)? Kalau sudah ada, pakai infrastruktur yang sama. Kalau belum ada sama sekali, ini kemungkinan butuh keputusan/akun provider baru dari user — **tanyakan**, karena ini bukan keputusan teknis kecil (menyangkut biaya & pilihan vendor).

5. **Layar Onboarding carousel 4 slide** (`screen-intro`): pindahkan konten & styling apa adanya dari prototipe. Slide 4 (pilihan sumber AI) harus menyimpan pilihan user ke `users.sumber_ai`, dan kalau pilih "API Key Gemini Sendiri" → alur ke `screen-api-guide` lalu form tambah key (simpan ke tabel `user_gemini_keys` atau serupa, per user, boleh lebih dari satu).

6. **Layar Setup Dompet & Kategori** (`screen-dompet`, `screen-kategori`): sambungkan ke tabel `wallets`/`categories` yang sudah ada di `index.html`, tapi sekarang terikat ke `user_id` baru, bukan `access_code`.

7. **Sesi & pengenalan ulang**: device sama → auto-login (kecuali sudah logout manual). Device beda → wajib verifikasi ulang. Implementasikan pakai token sesi yang disimpan di localStorage (nama key baru, jangan pakai nama lama `catatan_keuangan_access_code` biar tidak konflik/ambigu dengan mekanisme lama — sarankan migrasi/pembersihan key lama).

8. **Tombol Keluar (Logout)** di menu setting: confirm dialog + peringatan data offline belum sync (cek dulu ada tidaknya modul offline-sync existing di `index.html` sebelum membangun ulang).

9. **Refactor**: hapus/nonaktifkan seluruh mekanisme `access_code` bersama lama setelah migrasi selesai teruji (jangan dihapus di awal — jaga backward compatibility sampai migrasi data selesai, baru bersihkan).

### Kriteria Selesai Fase 1
Salin persis dari PRD bagian "Kriteria selesai" di FASE 1 (baris 150–158). Semua poin itu harus bisa didemokan sebelum lanjut ke Fase 2.

---

## 3. FASE 2 — Halaman Promosi & Fitur AI via WhatsApp

**Acuan tampilan:** `prototype-menu-baru.html` (screens: `screen-shortcut`, `screen-chat-full`, `screen-txai-input`, `screen-txai-loading`, `screen-txai-incomplete`, `screen-txai-saved`, `screen-txai-saved-multi`, `screen-notif-pwa`).

**Tujuan:** Jalur promosi eksternal + model interaksi AI via WA yang baru (WA sebagai jalur *input* saja, konfirmasi lewat notifikasi PWA — bukan balasan WA, karena kebijakan biaya Meta mulai 1 Oktober 2026).

### Tugas

1. **Halaman promosi**: halaman terpisah (link beda, dibagikan di TikTok). Detail desain lengkapnya ada di dokumen lain ("PRD Desain Halaman Promosi KaslyAI + Prompt Google Stitch") yang **tidak termasuk file yang kamu punya sekarang** — kalau user belum lampirkan dokumen itu, buat halaman promosi versi sederhana dulu (branding KaslyAI + tombol "Coba Aplikasi" ke Fase 1 + tombol WA ke nomor pribadi admin) dan beri tahu user bahwa detail final desainnya menyusul dari dokumen terpisah itu.

2. **Alur transaksi masuk via WA** (foto struk/teks/voice note → nomor resmi KaslyAI):
   - Terima pesan via webhook WA (sambungan ke infrastruktur yang sama dengan verifikasi Fase 1).
   - Panggil Gemini **lewat Edge Function** (bukan langsung, lihat poin keamanan di bagian 0) untuk membaca/parsing.
   - Simpan transaksi otomatis (tanpa konfirmasi WA dulu) ke tabel `transactions` milik user terkait (dicocokkan dari nomor pengirim WA → `user_id`).
   - Kirim **push notification PWA** (bukan balasan WA) berisi ringkasan + tombol Edit/Hapus, sesuai desain `screen-notif-pwa` di prototipe. Riset & putuskan: Web Push API native vs layanan pihak ketiga (Firebase Cloud Messaging) — PRD eksplisit bilang ini "belum diputuskan, bisa diambil saat pengerjaan" (bagian 8), jadi silakan putuskan sendiri (rekomendasi: FCM lebih matang untuk lintas-platform termasuk iOS Safari yang dukungannya terbatas — tapi ini keputusanmu, bukan keharusan).
   - Tombol Hapus di notifikasi → hapus 1 tap tanpa buka app, munculkan opsi Undo saat app dibuka lagi.

3. **Toggle "Balasan Otomatis WA"** (per-user, di menu setting, bukan di admin): ON = balasan WA seperti biasa (termasuk nanya balik kalau data kurang lengkap), OFF = notifikasi PWA jadi satu-satunya jalur (transaksi kurang lengkap jadi draf + notifikasi beda tampilan "butuh dilengkapi").

4. **Pertanyaan umum di luar transaksi** (misal "saldo saya berapa?") saat toggle OFF → balasan lewat notifikasi PWA ringkas, bukan balasan WA.

5. **Fitur mode terkunci** (koreksi saldo/limit anggaran/tujuan tabungan — ini fitur **percakapan multi-langkah existing** yang sudah ada di `index.html`, cari dulu modulnya) saat toggle OFF → dinonaktifkan total lewat WA, kasih notifikasi PWA yang mengarahkan ke web.

6. **App Shortcuts** (manifest.json PWA — tambah 2 shortcut): "Chat" (fitur existing, tidak berubah — cek modul chat yang sudah disebut di memori project) dan "Transaksi AI" baru (jalur cepat, simpan otomatis + notifikasi PWA, terpisah dari fitur "Transaksi AI" web yang sudah ada dan **tidak boleh diubah** — itu tetap pakai alur AI parsing → daftar hasil → tombol konfirmasi manual seperti sebelumnya).

### Kriteria Selesai Fase 2
Salin persis dari PRD bagian "Kriteria selesai" di FASE 2 (baris 199–208).

---

## 4. FASE 3 — Trial, Token, Pembayaran, & Dashboard Admin

**Acuan tampilan:** `admin-dashboard.html` (3 tab: Pengguna, Kode Token, Pengaturan).

**Tujuan:** Kontrol akses AI (trial → token lifetime) + dashboard admin dengan login sungguhan.

### Tugas

1. **Trial otomatis**: begitu akun terverifikasi (Fase 1), set `trial_mulai_at` = now, `trial_lama_hari` = ambil dari pengaturan admin (default 7). Akun admin pribadi juga tunduk aturan sama (PRD tegas soal ini, jangan dikecualikan).

2. **Pengecekan status trial/token**: WAJIB dipasang di **titik yang menghubungkan ke layanan AI** (di Edge Function pemanggil Gemini, bukan cuma di UI) — supaya tidak bisa dipaksa aktif oleh user yang paham teknis. Kalau trial habis & belum ada token: fitur dasar (transaksi manual) tetap jalan penuh selamanya, fitur AI (web & WA) dikunci di level server/Edge Function.

3. **Tabel `tokens`**: kode 8 karakter (huruf besar+angka), status pakai/belum, di-assign ke `user_id` tertentu begitu dipakai, cocok tanpa memandang besar-kecil huruf (uppercase-kan saat validasi). Satu kode = satu akun = selamanya, tidak bisa dipakai ulang oleh akun lain (reject dengan pesan jelas).

4. **Pop up trial-habis** (`modalTrialHabis` di `prototype-flow.html` sebenarnya sudah ada polanya) — muncul di app user, kolom input kode token langsung di situ.

5. **Dashboard admin** (`admin-dashboard.html`):
   - **Akses**: Supabase Auth email+password sungguhan (bukan Supabase Auth custom seperti user biasa — ini beda mekanisme, admin pakai Auth standar Supabase). Cek sesi/token valid sebelum render data apapun; kalau tidak valid → redirect ke form login.
   - **Data sensitif lintas-user**: WAJIB lewat Edge Function yang mengecek dulu request datang dari admin yang sudah login sah (verifikasi JWT Supabase Auth admin) — jangan query langsung dari browser ke tabel `users` pakai service role key atau semacamnya di client (itu akan bocor). RLS di tabel `users` untuk role anon/authenticated biasa harus menolak akses baca semua baris; hanya Edge Function dengan service role (server-side) yang boleh baca semua.
   - **Tab Pengguna**: statistik (total, trial aktif, trial habis, sudah bayar), search nama/nomor WA, list dengan nomor WA disamarkan (`0812xxxxxx74` — cek pola persis di prototipe), tombol "Kirim Token" (auto-assign dari stok token belum dipakai, disable kalau stok kosong dengan pesan arahan ke tab Kode Token), tombol "Reset WA" per user (dengan confirm dialog, hapus sesi WA user itu, wajib verifikasi ulang).
   - **Tab Kode Token**: tombol generate token baru (8 karakter random), list token + status.
   - **Tab Pengaturan**: lama trial (input hari + simpan), kelola API key Gemini bersama (tambah/hapus, multi-key), kelola API key pribadi admin (terpisah, prioritas dipakai duluan untuk kebutuhan AI admin sendiri).

6. **Kuota AI habis**: sistem auto-pindah ke key lain yang tersimpan (urutan: key user sendiri → key bersama; untuk admin: key pribadi admin → key bersama), kasih pesan ramah custom (bukan error mentah Google) kalau semua key habis.

### Kriteria Selesai Fase 3
Salin persis dari PRD bagian "Kriteria selesai" di FASE 3 (baris 260–265).

---

## 5. Batasan & Hal yang TIDAK Termasuk Scope Ini

Sesuai PRD bagian 7 & 8, jangan kerjakan ini kecuali diminta terpisah:
- Paket harga bertingkat (basic vs basic+AI+WA) — masih rencana masa depan, belum dirancang.
- Batas percobaan verifikasi anti-spam — sengaja belum diimplementasikan (masih tahap testing).
- Backup data tambahan di luar mekanisme bawaan Supabase.
- Domain custom (tetap pakai GitHub Pages untuk sekarang).
- Jalur alternatif untuk device tanpa WhatsApp — diasumsikan tidak perlu.

---

## 6. Checklist Sebelum Kamu Anggap Selesai (per fase)

- [ ] Semua item di "Kriteria selesai" fase terkait di PRD sudah bisa didemokan.
- [ ] Tidak ada API key (Gemini bersama/admin) yang bisa ditemukan lewat "inspect" browser di Network tab maupun di source JS.
- [ ] RLS aktif dan teruji: coba akses data akun lain dari akun yang sedang login, harus gagal.
- [ ] Fitur existing di `index.html` (wallet, transaksi, kategori, anggaran, tabungan, utang, recurring, chat AI, laporan) masih berfungsi normal setelah migrasi kunci dari `access_code` → `user_id`.
- [ ] Tampilan akhir konsisten dengan prototipe (`prototype-flow.html` / `prototype-menu-baru.html` / `admin-dashboard.html`) — bukan didesain ulang.
- [ ] Branding "KaslyAI" konsisten di semua layar baru (kapitalisasi persis, styling "Kasly" hitam + "AI" hijau di layar promo/hero sesuai PRD 1b).

---

## 7. Kalau Kamu Ragu

Berhenti dan tanya ke user (jangan menebak) untuk hal-hal berikut, karena ini bukan keputusan teknis murni:
- Provider WhatsApp Business API/webhook yang akan dipakai (kalau belum ada infrastruktur existing untuk ini).
- Isi & desain final halaman promosi (dokumen terpisah yang disebut PRD belum tentu tersedia).
- Nomor WA resmi "KaslyAI" dan nomor WA pribadi/bisnis admin (data konfigurasi, jangan diasumsikan/dikosongkan diam-diam).
- Apapun yang terasa bertentangan antara prompt ini dan isi PRD — PRD yang menang, tapi tetap konfirmasi ke user kalau perbedaannya signifikan.
