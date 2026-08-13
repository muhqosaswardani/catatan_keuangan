# PRD — Catatan Keuangan
**Dokumen kerja untuk Antigravity IDE (AI coding agent)**
Versi: 1.5 · Dibuat: 9 Agustus 2026

---

## 1. PRODUCT OVERVIEW

Catatan Keuangan adalah aplikasi keuangan pribadi **single-user** untuk mencatat transaksi (income/expense/transfer), mengelola beberapa dompet, kategori, budget bulanan, laporan, rekonsiliasi saldo (cross-check), dan pencatatan otomatis via AI (scan struk & analisa saldo pakai Gemini Vision).

Aplikasi ini sudah punya **versi final** dalam bentuk satu file HTML (`index.html`, vanilla HTML/CSS/JS, `localStorage` sebagai penyimpanan saat ini), sudah mendukung tampilan desktop & mobile secara responsif, dan fitur AI sudah berfungsi sungguhan (bukan simulasi). File ini adalah **source of truth fitur DAN tampilan** untuk pengembangan selanjutnya — Antigravity TIDAK perlu dan TIDAK BOLEH mendesain ulang UI-nya.

Tujuan proyek ini BUKAN membangun ulang fitur dari nol, melainkan:
1. Memindahkan penyimpanan data dari `localStorage` ke **database online (Supabase)**, dengan arsitektur offline-first, supaya web dan APK menampilkan data yang sama dan tetap bisa dipakai tanpa internet.
2. Membungkus aplikasi menjadi **APK Android** menggunakan **Capacitor**, dari satu codebase yang sama dengan web.
3. Menyediakan **hosting web** di **GitHub Pages**.
4. Menata **struktur project** agar rapi dan mudah dikembangkan lebih lanjut oleh Antigravity.

## 2. PRODUCT GOALS

- Satu codebase, dua cara akses: website (bisa dibuka dari browser mana pun) dan APK Android (terpasang di 1 HP).
- Data transaksi, wallet, kategori, budget selalu konsisten/sinkron antara web dan APK karena sama-sama membaca dari database online yang sama, dengan dukungan penuh pemakaian offline.
- Tidak ada fitur, kartu, angka, tampilan, atau perhitungan yang berubah dibanding `index.html` final — hanya tempat penyimpanan datanya yang berubah (dari localStorage ke Supabase + cache lokal).
- Akses tanpa sistem login formal (email/password), tapi tetap ada identitas data yang aman lewat kode akses unik di URL.
- Semua biaya infrastruktur (database) tetap di tier gratis.
- Data selalu punya cadangan otomatis di Google Drive, tanpa perlu diingat-ingat manual oleh user.
- APK tetap bisa dipakai offline, dan otomatis memakai versi terbaru begitu online.

## 3. NON-GOALS (secara eksplisit TIDAK dikerjakan sekarang)

- Integrasi WhatsApp API / reminder WhatsApp.
- Integrasi Google Sheets (field URL-nya tetap ada di Settings, tapi tidak difungsikan — lihat bagian 31, Future Roadmap).
- Sistem login multi-user / akun banyak pengguna.
- Desain ulang tampilan/UI — `index.html` yang dilampirkan adalah **versi final**, sudah mendukung layout desktop & mobile. Antigravity TIDAK mendesain ulang HTML/CSS, hanya menyambungkan data layer (localStorage → offline-first + Supabase), Capacitor, dan deployment.
- Migrasi data dummy — tidak relevan lagi, `index.html` final sudah bersih dari data dummy sejak awal (hanya berisi kategori default & 2 dompet kosong saat pertama kali dipakai).

## 4. CURRENT STATE (kondisi file `index.html` final yang dilampirkan — versi 2, sudah termasuk 5 fitur tambahan)

File `index.html` (~6.090 baris, versi terbaru) adalah **versi final aplikasi**, sudah responsif penuh (desktop & mobile), sudah punya fitur AI yang berfungsi sungguhan, DAN sudah mencakup 5 fitur tambahan yang disepakati di sesi sebelumnya: Checklist Transaksi Berulang, Transaksi Cepat, Tujuan Tabungan, Insight AI Otomatis, dan Utang Piutang — plus restrukturisasi navigasi (slot inti + "Lainnya"). Karakteristik teknisnya:

- **Penyimpanan**: saat ini masih 100% `localStorage` browser. Ini yang akan diganti/dilengkapi Antigravity dengan Supabase + cache lokal offline-first (lihat bagian 13–14, 22).
- **Tidak ada autentikasi** — siapa pun yang buka file langsung memakai data di browser tersebut (akan ditangani lewat kode akses di URL, bagian 19).
- **Layout responsif penuh**: mobile-first dengan bottom navigation (kini dengan slot inti + "Lainnya") di layar sempit; di atas 900px beralih ke sidebar kiri (`side-nav`, menampilkan semua 9 halaman langsung) + grid dashboard 2 kolom untuk Beranda & Laporan; di atas 1200px ada penyesuaian padding tambahan. Struktur ini FINAL, tidak diubah Antigravity.
- **Fitur AI sudah sungguhan** — Scan AI (baca struk) dan Analisa Saldo AI (baca screenshot m-banking) memanggil Gemini Vision API langsung, dengan fallback berurutan ke 3 model dan pesan error yang jelas untuk tiap jenis kegagalan. **Ini fitur aktif, BUKAN future roadmap lagi.**
- **Insight AI Otomatis juga sudah aktif** (fitur baru) — memakai jalur pemanggilan Gemini yang sama, tampil di Beranda & Laporan, auto-refresh 24 jam + tombol refresh manual.
- **Field "Google Sheets Web App URL"** di Settings masih sekadar tersimpan, belum difungsikan ke mana pun — tetap berstatus future (bagian 31).
- **Tidak ada data dummy** — `seedIfEmpty()` hanya membuat kategori default dan 2 dompet kosong saat pertama kali dipakai.
- **Navigasi sudah direstrukturisasi**: bottom nav mobile berisi 5 slot inti (default: Beranda, Transaksi, Checklist, Laporan, Budget — dikonfigurasi via `DEFAULT_NAV_CORE`) + tombol "Lainnya" untuk sisanya (Cek, Tujuan, Utang, Settings). User bisa kustomisasi slot inti sendiri (`getNavConfig`/`setNavConfig`, tersimpan di localStorage). Sidebar desktop tampilkan semua halaman langsung, tanpa konsep "Lainnya". Ini sudah final, sesuai spesifikasi.
- **Semua ikon navigasi & UI baru pakai SVG custom inline** (bukan emoji), konsisten dengan gaya ikon kategori yang sudah ada.
- Tidak ada manifest PWA atau service worker built-in — perlu ditambahkan Antigravity sebagai bagian dari implementasi offline-first (bagian 22).

**⚠️ Catatan diskrepansi teknis yang ditemukan (perlu diketahui pemilik produk, bukan blocker):**
Untuk fitur Transaksi Cepat, spesifikasi awal minta "6 nominal tersering **dalam 30 hari terakhir**". Implementasi saat ini (`last30CategorizedTx()`) memakai **30 transaksi terakhir yang tercatat** (berdasarkan jumlah record, lewat `.slice(-30)`), bukan filter berdasarkan tanggal 30 hari ke belakang. Demikian juga `modeAmountForCategory()` menghitung nominal tersering dari **seluruh riwayat transaksi** kategori tsb, bukan dibatasi 30 hari. Efek praktisnya mirip untuk pemakaian normal, tapi bisa beda hasil kalau frekuensi transaksi sangat jarang/sangat sering. Ini bukan bug fatal, tapi perlu diputuskan: dibiarkan (karena hasilnya cukup mirip) atau diperbaiki agar benar-benar berbasis tanggal.

## 5. EXISTING FEATURES (harus dipertahankan persis)

### 5.1 Beranda (Home)
- Ringkasan saldo total semua dompet.
- Filter periode: minggu ini / bulan ini (dengan navigasi geser periode).
- Grafik donut breakdown pengeluaran per kategori, dengan legend dan interaksi tap untuk highlight/drilldown.
- Badge perbandingan dengan periode sebelumnya.
- Quick access ke daftar transaksi terbaru.

### 5.2 Transaksi
- Tab riwayat transaksi dengan filter: dompet, kategori, periode (minggu/bulan, bisa digeser maju-mundur).
- Tambah transaksi baru lewat FAB (floating action button) → modal pilihan: **Transaksi (Income/Expense)**, **Transfer Antar Dompet**, **Tambah via AI (Scan Foto)**.
- Form transaksi: toggle Pengeluaran/Pemasukan, pilih dompet, pilih kategori (dengan quick-chip kategori & jumlah yang paling sering dipakai), input jumlah via keypad kalkulator custom (mendukung operasi +/-/×/÷ langsung di keypad), tanggal, catatan opsional.
- Edit & hapus transaksi individual (efeknya menyesuaikan ulang saldo dompet terkait).
- Transfer antar dompet: kurangi saldo dompet asal, tambah saldo dompet tujuan, tercatat sebagai 1 entri transfer.
- **Tambah via AI (Scan Foto) — fitur AKTIF/sungguhan**: foto struk dikirim ke Gemini Vision API (pakai API key user di Settings), hasil baca otomatis dipakai untuk isi form transaksi. Wajib ada Gemini API Key terisi; kalau belum diisi, muncul pesan yang mengarahkan user ke Settings.

### 5.3 Budget
- Set limit budget per kategori pengeluaran, per bulan.
- Visualisasi gauge (progress) pemakaian budget per kategori.
- Kalkulasi sisa alokasi harian berdasarkan sisa hari dalam bulan dan sisa budget.
- Kelola daftar limit budget per kategori (tambah/ubah).
- Navigasi geser bulan.

### 5.4 Laporan
- Dua sub-tab: **Bulanan** dan **Mingguan**.
- Grafik donut pengeluaran per kategori (dengan legend, tap untuk drilldown lihat detail transaksi per kategori).
- Grafik tren (trend chart) dengan pilihan rentang waktu.
- Ringkasan saldo awal/akhir per periode.
- Navigasi geser periode (bulan/minggu).

### 5.5 Cross-check (Rekonsiliasi Saldo)
- Pilih dompet yang mau dicek.
- Tampilkan saldo tercatat di app.
- **"Analisa dengan AI" — fitur AKTIF/sungguhan**: screenshot m-banking/foto uang tunai dikirim ke Gemini Vision API, hasilnya berupa daftar item saldo per rekening/e-wallet yang benar-benar terdeteksi dari gambar (bukan data karangan). Wajib ada Gemini API Key terisi.
- Penyesuaian saldo manual — user bisa input item penyesuaian sendiri (tanpa AI) dan menerapkannya sebagai transaksi "Penyesuaian Saldo".
- Riwayat penyesuaian saldo (log semua penyesuaian yang pernah dilakukan).

### 5.6 Kelola Kategori
- Tambah/hapus/reorder kategori, terpisah untuk expense & income.
- Setiap kategori punya: nama, tipe (expense/income), ikon (dipilih dari library ikon SVG bawaan — lebih dari 25 pilihan ikon: makan, transport, belanja, tagihan, hiburan, gaji, tabungan, kesehatan, dll), dan warna (dari palet 12 warna).
- Kategori khusus sistem: "Penyesuaian Saldo" (dipakai otomatis oleh fitur cross-check), tidak untuk dihapus user.

### 5.7 Settings
- **Field Gemini API Key** (password-masked, toggle show/hide) — status: **AKTIF, wajib diisi user sendiri agar fitur Scan AI & Analisa Saldo AI berfungsi**. Disimpan di sisi client, dipakai langsung untuk memanggil Gemini Vision API.
- Field Google Sheets Web App URL — status: **future feature, tampil tapi tidak difungsikan** (lihat bagian 31).
- **Export data**: unduh semua data (wallets, transactions, categories, budgets, settings) sebagai file `.json`.
- **Import data**: pulih data dari file `.json` (menimpa seluruh data saat ini, dengan konfirmasi).
- Akses ke Kelola Kategori.
- **Reset semua data**: hapus semua dompet/transaksi/budget, dengan konfirmasi mengetik kata "HAPUS".

### 5.8 Onboarding
- Ditampilkan sekali di kunjungan pertama (ditandai dengan flag `onboarded`), tombol "Mulai Catat" untuk menutup.

### 5.9 Checklist Transaksi Berulang (halaman baru: `checklist`)
- Item berulang bulanan (nama, jenis income/expense, jumlah, dompet, kategori, tanggal jatuh tempo per bulan).
- Badge indikator di Beranda kalau ada item jatuh tempo/terlambat.
- Tombol "Tandai Sudah Bayar/Terima" → baru saat itu transaksi sungguhan tercatat, tanggal jatuh tempo otomatis maju ke bulan berikutnya.
- Status "Terlambat" untuk item yang lewat tanggal tapi belum dikonfirmasi.
- Kelola item berulang (tambah/edit/hapus/nonaktifkan) via modal (`modalRecurringForm`, dsb).

### 5.10 Transaksi Cepat (di halaman `checklist` yang sama)
- Kategori yang ditandai sebagai shortcut (dikelola via `modalShortcutManage`, mirip pola Kelola Kategori) tampil sebagai deretan tombol/chip.
- Tap kategori → mini-form (`modalQuickTx`): nominal + keterangan opsional saja; tanggal/kategori/jenis/dompet otomatis dari konteks.
- Baris tombol nominal cepat di bawah input manual, diisi dari kategori yang sering dipakai (lihat catatan diskrepansi di bagian 4 soal basis perhitungannya).
- Kategori shortcut bisa otomatis (top pemakaian) atau override manual oleh user.

### 5.11 Tujuan Tabungan (halaman baru: `tujuan`)
- Multi-goal, defaultnya kosong (fitur opsional).
- Tiap goal: nama, nominal target, dompet yang dikaitkan (progress = saldo dompet itu), tanggal target opsional.
- Progress bar otomatis mengikuti saldo dompet terkait, tanpa input manual.

### 5.12 Insight Otomatis dari AI (di halaman Beranda & Laporan, bukan halaman baru)
- Ringkasan 2–4 kalimat berbahasa Indonesia dari Gemini API, berbasis ringkasan data (bukan data mentah).
- Auto-refresh 1x/24 jam (dicek dari timestamp terakhir) + tombol refresh manual (`insightHomeRefreshBtn`, `insightLapRefreshBtn`).
- Butuh Gemini API Key terisi; kalau belum, tampil pesan arahan ke Settings (`insightHomeNoKey`, dsb) — bukan error mentah.

### 5.13 Utang Piutang (halaman baru: `utang`)
- Tiap entri: nama orang, jenis (Saya Berhutang/Orang Berhutang), jumlah, tanggal, catatan, tanggal jatuh tempo opsional (tanpa reminder wajib).
- Dua tampilan via sub-tab: **Per Orang** (`debtSubtabPersonPanel`, saldo bersih per nama) dan **Semua Transaksi** (`debtSubtabAllPanel`, riwayat lengkap urut waktu).
- Pelunasan (`modalDebtPayoff`) WAJIB memengaruhi saldo dompet sungguhan (income untuk pelunasan piutang, expense untuk pelunasan utang), pakai kategori khusus sistem "Utang Piutang". Status entri berubah jadi "Lunas", tetap ada di riwayat.

### 5.14 Navigasi & Menu Bar (restrukturisasi, bukan fitur halaman)
- Bottom nav mobile: 5 slot inti (Beranda wajib + 4 lainnya, default: Transaksi, Checklist, Laporan, Budget) + tombol "Lainnya" (berisi Cek, Tujuan, Utang, Settings secara default).
- User bisa kustomisasi slot inti sendiri lewat halaman pengaturan nav (`modalNavConfig`), tersimpan persisten.
- Sidebar desktop tampilkan semua 9 halaman langsung, tanpa konsep "Lainnya".
- Semua ikon navigasi pakai SVG custom inline, tanpa emoji.

## 6. USER FLOW

1. User membuka link web (dengan kode akses tersimpan di URL/bookmark) ATAU membuka APK di HP.
2. Jika kode akses belum ada di link (kunjungan pertama di perangkat/browser tsb), sistem membuatkan kode akses baru dan menampilkannya sebagai bagian dari URL yang harus di-bookmark user (lihat bagian 19. AUTHENTICATION).
3. Onboarding singkat tampil di kunjungan pertama untuk kode akses tsb.
4. User mendarat di Beranda, melihat ringkasan saldo, breakdown pengeluaran, insight AI, dan badge checklist berulang kalau ada yang jatuh tempo.
5. User mencatat transaksi lewat FAB (manual/Scan AI/transfer) ATAU lewat Transaksi Cepat di halaman Checklist ATAU dengan menandai item berulang "Sudah Bayar".
6. Saldo dompet, laporan, status budget, dan progress tujuan tabungan otomatis ter-update, tersimpan lokal dulu lalu tersinkron ke database online saat ada koneksi.
7. User bisa berpindah antar 9 halaman kapan saja — lewat slot inti bottom nav atau tombol "Lainnya" (mobile), atau sidebar (desktop); semua data yang ditampilkan selalu berasal dari sumber yang sama, baik dibuka dari web maupun APK, baik online maupun offline.

## 7. INFORMATION ARCHITECTURE

9 halaman total: **Beranda · Laporan · Transaksi · Budget · Cross-check · Checklist (+ Transaksi Cepat) · Tujuan Tabungan · Utang Piutang · Settings**

Struktur ini FINAL, sudah diimplementasikan penuh di `index.html`, termasuk restrukturisasi navigasi (bagian 5.14): bottom navigation dengan 5 slot inti + "Lainnya" di layar sempit (mobile), beralih ke sidebar kiri (`side-nav`, menampilkan semua 9 halaman) di layar ≥900px (desktop). Antigravity tidak mengubah struktur navigasi ini.

## 8–10. DESKTOP UX / MOBILE UX / RESPONSIVE RULES

**Sudah final, diimplementasikan penuh di `index.html`** — bukan lagi open question:
- **Mobile** (default, <900px): bottom navigation (5 slot inti + "Lainnya"), FAB untuk tambah transaksi, card vertikal satu kolom, modal tampil sebagai bottom-sheet.
- **Desktop** (≥900px): sidebar kiri (`side-nav`, semua 9 halaman langsung) menggantikan bottom nav & FAB, dashboard Beranda & Laporan berubah jadi grid 2 kolom, modal tampil sebagai dialog di tengah layar (bukan bottom-sheet).
- **Layar lebar** (≥1200px): padding tambahan di sisi kiri-kanan konten.
- Data, fitur, dan perhitungan yang ditampilkan tetap identik di semua breakpoint — hanya tata letak yang menyesuaikan, sesuai prinsip di awal PRD ini.

**Instruksi untuk Antigravity**: JANGAN mengubah struktur HTML/CSS yang sudah ada di `index.html` kecuali diminta eksplisit oleh pemilik produk. Fokus pada bagian JavaScript data layer (fungsi `get*`/`set*`), integrasi Supabase + offline-first, dan konfigurasi Capacitor.

## 11. FEATURE REQUIREMENTS

Semua fitur di bagian 5 (Existing Features) — termasuk fitur AI yang sudah aktif — adalah requirement wajib, harus berfungsi identik dengan `index.html` final setelah migrasi data layer ke Supabase + offline-first, kecuali:
- Penyimpanan data: dari `localStorage` murni → penyimpanan lokal (offline-first) + sinkronisasi Supabase.
- Field Google Sheets URL: tetap tampil tapi non-fungsional (future roadmap, bagian 31).
- Panggilan ke Gemini Vision API (fitur AI) **tetap dilakukan langsung dari sisi client seperti sekarang** (tidak perlu dialihkan lewat Supabase/backend), kecuali Antigravity menemukan alasan teknis kuat untuk mengubahnya — jika demikian, ini WAJIB didiskusikan dulu ke pemilik produk (bukan keputusan sepihak).

## 12. BUSINESS LOGIC

Pertahankan logika bisnis yang ada di `index.html`, terutama:
- Perhitungan saldo dompet: `applyBalanceDelta()` — income menambah saldo, expense mengurangi, transfer memindahkan antar dompet.
- Status budget: `calculateBudgetStatus()`, `getEffectiveBudget()` — limit budget berlaku dari bulan limit tsb diset, ke bulan-bulan berikutnya sampai ada limit baru.
- Alokasi harian tersisa: `getDailyAllowance()`.
- Kategori khusus "Penyesuaian Saldo" dipakai otomatis saat user melakukan cross-check/penyesuaian saldo — dibuat otomatis jika belum ada (`getOrCreateAdjustmentCategory()`).
- Saat transaksi diedit/dihapus, saldo dompet harus disesuaikan ulang (bukan cuma ganti angka baru, tapi batalkan efek transaksi lama dulu).
- Pemanggilan Gemini Vision (`callGeminiRaw`, `aiScanWithGemini`, `ccAnalyzeWithGemini`) dengan fallback berurutan ke 3 model dan penanganan pesan error per jenis kegagalan (key salah/403, kuota habis/429, server overload/503, gagal koneksi).

## 13. DATA MODEL

Struktur entitas (dipertahankan dari HTML lama, akan dipetakan ke tabel Supabase):

**Wallet**
- `id`, `name`, `balance`, `updatedAt` (waktu terakhir diubah — untuk sinkronisasi offline)

**Transaction**
- `id`, `walletId`, `categoryId`, `category` (nama kategori, disimpan redundan untuk histori), `type` (`income` / `expense` / `transfer`), `amount`, `date`, `note`, `toWalletId` (khusus transfer), `updatedAt` (waktu terakhir diubah — untuk sinkronisasi offline)

**Category**
- `id`, `name`, `type` (`expense` / `income`), `icon` (key dari library ikon), `color` (hex), `updatedAt`

**Budget**
- `categoryId`, `month` (format `YYYY-MM`), `limit`, `updatedAt`

**Settings**
- `geminiApiKey` (**AKTIF** — dipakai sungguhan untuk memanggil Gemini Vision API), `sheetsWebAppUrl` (disimpan tapi non-fungsional, future)

**RecurringItem** *(baru — Checklist Transaksi Berulang)*
- `id`, `name`, `type` (`income`/`expense`), `amount`, `walletId`, `categoryId`, `dayOfMonth`, `active`, `lastConfirmedDate`, `updatedAt`

**ShortcutOverride** *(baru — Transaksi Cepat)*
- Map `categoryId` → `boolean` (override manual aktif/nonaktif di luar top-otomatis), `updatedAt`

**SavingsGoal** *(baru — Tujuan Tabungan)*
- `id`, `name`, `targetAmount`, `walletId`, `targetDate` (opsional), `updatedAt`

**DebtEntry** *(baru — Utang Piutang)*
- `id`, `personName`, `type` (`i_owe`/`owed_to_me`), `amount`, `date`, `note`, `dueDate` (opsional), `status` (`active`/`paid`), `payoffWalletId`, `payoffDate`, `updatedAt`

**InsightCache** *(baru — Insight AI Otomatis)*
- `scope` (`home`/`laporan`), `text`, `generatedAt`

**NavConfig** *(baru — kustomisasi navigasi)*
- `core` (array tab, 5 item, `beranda` selalu index 0), `updatedAt`

Semua entitas di atas perlu ditambahkan kolom kepemilikan (mis. `access_code` atau `owner_key`) untuk memisahkan data per kode akses, meski aplikasi ini single-user (lihat bagian 19).

**Kolom `updatedAt` bersifat wajib** di setiap entitas yang bisa diubah dari 2 sumber (web & APK) — dipakai sebagai dasar aturan penyelesaian konflik sinkronisasi (lihat bagian 22). `InsightCache` dan `NavConfig` boleh dikecualikan dari sinkronisasi lintas-perangkat kalau Antigravity menilai lebih tepat sebagai preferensi lokal per perangkat — silakan konfirmasi ke pemilik produk sebelum diputuskan.

## 14. STORAGE STRATEGY

- Aplikasi memakai **strategi offline-first**: setiap perangkat (web maupun APK) menyimpan **salinan data lokal** (mis. IndexedDB di browser/Capacitor, bukan sekadar `localStorage` biasa yang sifatnya sederhana) sebagai sumber baca/tulis utama sehari-hari, supaya semua fitur (input, edit, lihat dashboard, laporan) tetap berfungsi penuh tanpa internet — persis seperti perilaku HTML lama.
- **Supabase adalah sumber kebenaran jangka panjang** (source of truth) yang disinkronkan dengan salinan lokal setiap ada koneksi internet.
- Fungsi `get*()`/`set*()` di data layer (`getWallets`, `setWallets`, `getTransactions`, dst.) dari HTML lama diubah menjadi: baca/tulis ke penyimpanan lokal dulu (selalu berhasil, instan), lalu memicu proses sinkronisasi ke Supabase di latar belakang saat online.
- Semua baris data di Supabase perlu terasosiasi dengan kode akses (lihat bagian 19), supaya query hanya mengambil data milik kode akses yang sedang aktif.

## 15. PROJECT ARCHITECTURE & 16. CODE ORGANIZATION

Antigravity perlu menentukan struktur folder yang rapi (mis. memisahkan source code utama, konfigurasi Capacitor, aset ikon/splash), dengan prinsip:
- Satu source code (`index.html` + JS/CSS pendukung) dipakai bersama oleh web dan APK — tidak ada dua codebase terpisah.
- Konfigurasi Capacitor terpisah dari source code aplikasi (folder `android/` hasil generate Capacitor tidak diedit manual kecuali perlu).
- Environment/konfigurasi Supabase (URL, anon key) dikelola dengan cara yang aman untuk dipakai di sisi client (public anon key), tidak menaruh secret sensitif di kode yang ter-commit ke repo publik.

## 17. ANDROID STRATEGY

- Gunakan **Capacitor** untuk membungkus source code web menjadi APK.
- **Strategi update — offline-first dengan auto-refresh saat online** (revisi dari draft awal "selalu live"): APK menyimpan **salinan tampilan aplikasi di HP** (bukan murni selalu ambil dari internet), supaya aplikasi tetap bisa dibuka dan dipakai penuh tanpa sinyal. Setiap kali ada koneksi internet, aplikasi otomatis mengecek dan mengambil versi terbaru dari website (GitHub Pages) di latar belakang, lalu memakainya di pembukaan berikutnya. Konsekuensinya:
  - Perubahan kode yang di-deploy ke website akan **otomatis nyampe ke APK begitu APK punya sinyal**, TANPA perlu install ulang manual — hanya saja tidak instan real-time seperti versi "selalu live", melainkan "pas online berikutnya".
  - Saat tidak ada sinyal sama sekali, APK tetap bisa dibuka dan dipakai penuh (input transaksi, lihat dashboard, laporan, dll) memakai salinan tampilan & data terakhir yang tersimpan di HP.
  - Install ulang APK baru hanya diperlukan untuk perubahan level native/shell aplikasi (jarang terjadi — misal nanti nambah izin akses kamera HP secara native).
- APK dipakai di 1 HP (tidak perlu strategi multi-device untuk APK).
- Build APK dilakukan lewat Android Studio. **Karena pemilik produk bukan programmer, Antigravity WAJIB memandu proses ini secara eksplisit langkah demi langkah** — instalasi Android Studio, konfigurasi signing key, proses build debug lalu release — dengan bahasa sederhana, satu langkah pada satu waktu, dan verifikasi tiap langkah berhasil sebelum lanjut ke langkah berikutnya. Jangan asumsikan pemilik produk paham istilah Android development.
- Perlu icon & splash screen aplikasi (aset akan ditentukan kemudian — tandai sebagai open question jika belum ada aset).
- Debug build untuk testing di HP, release build (signed) untuk pemakaian sehari-hari.
- Versioning APK: gunakan version code/name sederhana yang naik tiap rilis baru (rilis baru hanya untuk perubahan native, sesuai poin di atas).
- Saat install APK pertama kali (di luar Play Store), HP kemungkinan menampilkan peringatan "sumber tidak dikenal"/Play Protect — ini normal untuk APK pribadi; Antigravity perlu mendokumentasikan cara mengizinkannya dengan bahasa sederhana.

## 18. WEB DEPLOYMENT

- Hosting: **GitHub Pages**, dengan format link `https://username.github.io/nama-project/`.
- Pemilik produk sudah punya akun GitHub.
- `index.html` final (disiapkan terpisah oleh pemilik produk) menjadi entry point yang di-deploy.
- Struktur repository perlu memisahkan source yang di-deploy vs source Capacitor/Android agar deployment GitHub Pages tidak ikut menyertakan file Android yang tidak relevan.

## 19. AUTHENTICATION

- **Tanpa sistem login (email/password).**
- Identitas data memakai **kode akses unik** yang otomatis dibuat oleh aplikasi saat pertama kali dipakai, dan "menempel" sebagai parameter di URL (mis. `?akses=a8x92kq`).
- User menyimpan akses ke datanya dengan cara **bookmark link lengkap** (termasuk kode akses) di tiap perangkat/browser yang dipakai — bukan dengan mengetik ulang kode secara manual tiap kali.
- Semua data di Supabase (wallet, transaksi, kategori, budget) difilter berdasarkan kode akses ini.
- Ini BUKAN sistem keamanan yang setara login sungguhan — siapa pun yang tahu/punya link lengkapnya bisa mengakses data. Ini konsekuensi yang disadari dan diterima oleh pemilik produk demi kesederhanaan (single-user, tanpa login).

## 20. SECURITY

- Karena tanpa login formal, kode akses di URL berfungsi sebagai satu-satunya lapisan pemisah data — perlakukan sebagai informasi sensitif (jangan dibagikan/screenshot sembarangan).
- Data yang tersimpan adalah data keuangan pribadi (nominal transaksi, nama kategori) — bukan data pembayaran (tidak ada nomor kartu/rekening yang disimpan).
- Supabase Row Level Security (RLS) sebaiknya dikonfigurasi agar query hanya bisa mengambil/mengubah data dengan kode akses yang sesuai.
- **Gemini API Key** disimpan & dipakai di sisi client (browser/APK), sesuai perilaku `index.html` final — ini artinya key tersebut tersimpan di penyimpanan lokal perangkat, bukan di server. Wajar untuk pemakaian personal (key milik user sendiri, dipakai untuk akun Gemini miliknya sendiri), tapi Antigravity perlu pastikan key ini juga ikut ter-backup dengan aman kalau nanti disatukan ke Supabase (jangan sampai ter-expose ke user lain — meski di single-user seperti sekarang, dampaknya rendah).

## 21. ERROR HANDLING

- Pertahankan validasi form yang sudah ada di HTML lama (mis. dompet/kategori wajib dipilih, jumlah harus > 0) — berlaku baik online maupun offline, karena disimpan ke lokal dulu.
- Kegagalan **sinkronisasi ke Supabase** (mis. karena tidak ada internet) TIDAK menggagalkan penyimpanan transaksi — transaksi tetap tersimpan lokal, cukup ditandai "belum tersinkron" dengan indikator jelas ke user, bukan pesan error yang menakutkan.
- Kalau sinkronisasi gagal berkali-kali walau sudah online (mis. karena masalah lain di Supabase), baru tampilkan pesan error yang jelas ke user.
- Import data JSON yang formatnya tidak valid: tetap tampilkan pesan "File tidak valid" seperti versi lama.

## 22. OFFLINE/ONLINE BEHAVIOR

Aplikasi ini bersifat **offline-first** — prinsip: semua fitur inti (input transaksi, edit, hapus, lihat dashboard, laporan, budget) harus tetap berfungsi penuh tanpa koneksi internet, persis seperti perilaku HTML lama yang berbasis `localStorage`.

**Perilaku detail:**
- Web maupun APK membaca/menulis ke **penyimpanan lokal di perangkat** sebagai langkah pertama (instan, tidak menunggu internet).
- Selama offline, semua perubahan (transaksi baru, edit, dsb.) ditandai sebagai "belum tersinkron" dan ditahan dalam antrian.
- Begitu koneksi internet tersedia kembali, antrian perubahan **otomatis dikirim ke Supabase** di latar belakang. Ditambah **tombol "Sync" manual** yang bisa dipicu kapan saja oleh user saat online, untuk memaksa sinkronisasi tanpa menunggu proses otomatis.
- Data terbaru dari Supabase (hasil perubahan dari perangkat lain, mis. dari web sementara APK sempat offline) juga ditarik turun ke penyimpanan lokal saat sinkronisasi berjalan.

**Aturan penyelesaian konflik (saat data yang sama diubah dari web dan APK sebelum sempat sync):**
- Berbasis **"perubahan terakhir yang menang"** (last-updated-wins), menggunakan kolom `updatedAt` di setiap entitas (lihat bagian 13).
- Saat sinkronisasi menemukan data yang sama sudah berubah di kedua sisi, versi dengan `updatedAt` paling baru yang dipakai sebagai versi final, versi yang lebih lama ditimpa.

**Yang TIDAK berfungsi saat offline:**
- Fitur "Scan AI" dan "Analisa Saldo AI" (karena statusnya memang masih simulasi/mock, bukan soal koneksi — lihat bagian 3, Non-Goals). Kalau nanti fase AI sungguhan (Future Roadmap) dikerjakan, fitur itu barulah butuh internet.
- Auto-backup mingguan ke Google Drive (bagian 24a) — perlu koneksi saat jadwalnya tiba; kalau offline saat itu, backup tertunda ke kesempatan online berikutnya.

## 23. DATA MIGRATION dari aplikasi lama

- Data dummy di file HTML lama **tidak dipindahkan** — dihapus, tidak dipakai.
- Kategori default (lihat bagian 11) tetap dipertahankan sebagai starting point aplikasi baru.
- Tidak ada proses migrasi data user sungguhan dari aplikasi lama karena aplikasi lama belum pernah dipakai untuk data nyata (masih berisi dummy).

## 24. BACKUP/RESTORE

- Fitur **Export** (unduh JSON) dan **Import** (unggah JSON) di Settings tetap dipertahankan, tapi sumber datanya berubah dari `localStorage` menjadi Supabase — export mengambil data terbaru dari Supabase, import menimpa data di Supabase (bukan lagi localStorage).

## 24a. AUTO-BACKUP KE GOOGLE DRIVE

Tambahan di luar Export manual yang sudah ada:

- Aplikasi membuat file backup JSON **otomatis, mingguan** (sesuai jadwal, tidak perlu dipicu manual oleh user).
- File otomatis diunggah ke **Google Drive** milik user.
- Memerlukan **satu kali izin sign-in Google** khusus untuk fitur backup ini saja (terpisah dari prinsip "tanpa login" untuk pemakaian aplikasi sehari-hari — izin ini murni untuk akses folder backup di Drive).
- **Retensi file**: hanya **4 file backup terakhir** yang disimpan di Drive. File backup yang lebih lama dari itu **dihapus otomatis** supaya tidak menumpuk (kira-kira setara cadangan ~1 bulan ke belakang, karena backup mingguan).
- Ini pelengkap, BUKAN pengganti, fitur Export manual di Settings — keduanya tetap ada.
- Catatan risiko: keandalan server Supabase sendiri secara umum cukup baik untuk skala personal, tapi **tidak ada jaminan uptime resmi di tier gratis**. Risiko kehilangan data yang lebih nyata justru datang dari kesalahan manusia/bug kode (mis. tidak sengaja reset data), bukan dari server down — ini alasan utama fitur auto-backup ini penting, bukan cuma soal keandalan Supabase semata.

## 25. TESTING REQUIREMENTS

- Setiap fitur di bagian 5 (Existing Features) harus diuji fungsinya identik dengan versi HTML lama setelah migrasi ke Supabase (mis. tambah transaksi → saldo dompet berubah benar; edit transaksi → saldo disesuaikan ulang dengan benar; hapus transaksi → saldo dikembalikan).
- Uji sinkronisasi online: transaksi yang ditambahkan lewat web harus terlihat di APK setelah sync (dan sebaliknya).
- **Uji mode offline**: matikan koneksi internet di perangkat, pastikan tambah/edit/hapus transaksi, lihat dashboard, laporan, dan budget tetap berfungsi normal tanpa error.
- **Uji sync setelah offline**: buat beberapa perubahan saat offline, nyalakan kembali internet, pastikan semua perubahan otomatis terkirim ke Supabase (dan lewat tombol Sync manual juga berhasil).
- **Uji resolusi konflik**: ubah data yang sama dari web dan APK saat salah satunya offline, pastikan setelah sync versi dengan `updatedAt` paling baru yang menang.
- Uji kode akses: buka link tanpa kode akses → kode baru dibuat; buka link dengan kode akses lama → data yang sama muncul kembali.
- Antigravity WAJIB menjalankan test/verifikasi fungsional setelah tiap perubahan signifikan sebelum melanjutkan ke tahap berikutnya.

## 26. BUILD REQUIREMENTS

- Web: build/deploy ke GitHub Pages harus menghasilkan link yang bisa diakses publik dan menampilkan aplikasi dengan benar.
- Android: build APK (debug untuk testing, release untuk pemakaian) lewat Capacitor + Android Studio, harus menghasilkan file `.apk` yang bisa di-install manual di HP.

## 27. GIT/GITHUB WORKFLOW

- Gunakan Git commit per fase/tahap pekerjaan yang jelas (bukan satu commit besar di akhir).
- Push ke GitHub setelah tiap fase selesai dan teruji.
- Pesan commit harus mendeskripsikan perubahan secara jelas (bahasa sederhana, tidak perlu istilah teknis rumit).

## 28. DEFINITION OF DONE

Satu fase dianggap selesai jika:
- Fitur yang dikerjakan pada fase itu berfungsi sama seperti di HTML lama (atau sesuai requirement baru bila ada perubahan yang disetujui).
- Tidak ada fitur lama yang rusak/regresi akibat perubahan fase ini.
- Sudah diuji secara fungsional (bukan cuma "kelihatannya jalan").
- Perubahan sudah di-commit ke Git dengan pesan yang jelas.
- Error yang muncul selama pengerjaan sudah diperbaiki, bukan dibiarkan/di-skip.

## 29. ACCEPTANCE CRITERIA

- [ ] Semua data (wallet, transaksi, kategori, budget, settings) tersimpan lokal di perangkat DAN tersinkron ke Supabase (bukan localStorage biasa sebagai satu-satunya penyimpanan).
- [ ] Data yang sama muncul baik dibuka lewat web maupun APK, menggunakan kode akses yang sama, setelah sinkronisasi.
- [ ] **Semua fitur inti (input, edit, hapus transaksi, lihat dashboard, laporan, budget) tetap berfungsi penuh tanpa koneksi internet.**
- [ ] Perubahan yang dibuat saat offline otomatis tersinkron ke Supabase begitu online kembali, dan tombol Sync manual berfungsi.
- [ ] Konflik data (perubahan sama dari web & APK) diselesaikan dengan aturan "perubahan terakhir menang" berdasarkan `updatedAt`.
- [ ] Kode akses otomatis dibuat di kunjungan pertama dan menempel di URL, tanpa perlu login manual.
- [ ] Semua fitur di bagian 5 berfungsi tanpa regresi dibanding versi HTML lama.
- [ ] Field Gemini API Key berfungsi sungguhan (Scan AI, Analisa Saldo AI, & Insight Otomatis aktif memanggil Gemini Vision), Google Sheets URL tetap tampil tapi tidak memanggil API apa pun.
- [ ] Checklist Transaksi Berulang, Transaksi Cepat, Tujuan Tabungan, Insight AI Otomatis, dan Utang Piutang berfungsi tanpa regresi setelah migrasi data layer, termasuk saat offline (kecuali panggilan AI yang memang butuh internet).
- [ ] Navigasi (5 slot inti + "Lainnya" di mobile, sidebar penuh di desktop, kustomisasi slot inti) tetap berfungsi tanpa regresi.
- [ ] Website berhasil di-deploy dan bisa diakses lewat link GitHub Pages.
- [ ] File APK berhasil dibuat lewat Capacitor dan bisa di-install di HP.
- [ ] APK otomatis memakai versi terbaru aplikasi begitu online (tanpa install ulang manual).
- [ ] Export/Import data JSON tetap berfungsi, kini bersumber dari Supabase.
- [ ] Backup JSON otomatis ke Google Drive berjalan mingguan, dan hanya 4 file terakhir yang disimpan (lebih lama otomatis terhapus).
- [ ] Tidak ada biaya berbayar yang diperlukan untuk skala pemakaian personal saat ini.

## 29a. PRE-FLIGHT CHECKLIST & KONFIRMASI WAJIB (WAJIB dijalankan Antigravity)

Sebelum mulai mengerjakan APAPUN (termasuk sebelum Fase 1), Antigravity **WAJIB** melakukan langkah-langkah berikut secara eksplisit — bukan berasumsi, bukan menebak, bukan langsung jalan:

1. **Konfirmasi dokumen sudah lengkap**: pastikan sudah menerima PRD ini secara utuh dan file `index.html` final. Kalau salah satu belum ada, berhenti dan minta ke pemilik produk.
2. **Tanyakan satu per satu, JANGAN diam-diam diasumsikan**, data berikut sebelum dipakai di kode (tunjukkan ke pemilik produk daftar ini di awal sesi, dalam bahasa sederhana):
   - Apakah akun GitHub di komputer ini sudah bisa dipakai untuk push (login `git`/`gh`)? Kalau belum, **pandu setup-nya dulu** sebelum lanjut.
   - Nama repository GitHub yang akan dipakai — **usulkan nama, tapi minta persetujuan eksplisit sebelum benar-benar membuat repo baru.**
   - Project URL & API Key Supabase — **minta pemilik produk menempelkannya**, jangan mengarang/menebak nilai apa pun.
   - Client ID & Client Secret Google (untuk fitur auto-backup Drive) — sama, minta ditempelkan langsung.
   - Nama produk final untuk dipakai di judul repo/APK (default: "Catatan Keuangan", tapi konfirmasi dulu).
3. **Sebelum aksi yang tidak bisa dibatalkan dengan mudah** — membuat repository baru, melakukan push pertama kali, menjalankan build release APK, mengubah skema tabel Supabase yang sudah berisi data — Antigravity **WAJIB berhenti sejenak dan minta konfirmasi eksplisit "lanjutkan?"** ke pemilik produk, bukan langsung eksekusi.
4. **Setelah keystore APK dibuat** (saat build release pertama kali), Antigravity WAJIB secara eksplisit **mengingatkan pemilik produk untuk menyimpan file keystore itu di tempat aman**, dan menjelaskan konsekuensinya kalau hilang (lihat bagian 32, Risks).
5. **Setelah kode akses URL pertama kali dibuat**, Antigravity WAJIB mengingatkan pemilik produk untuk **langsung bookmark link lengkapnya**.
6. Kalau di tengah jalan ternyata ada data dari daftar poin 2 yang belum tersedia, **Antigravity berhenti di fase itu dan menyampaikan dengan jelas data apa yang masih kurang** — tidak melompat ke fase lain untuk "menghindar", dan tidak mengarang nilai sementara/placeholder untuk kredensial sungguhan.

## 30. IMPLEMENTATION PHASES (usulan)

1. **Fase 0 — Pre-Flight Checklist**: jalankan seluruh langkah di bagian 29a sebelum menyentuh kode sama sekali.
2. **Fase 1 — Setup Supabase & Data Layer**: *(checkpoint: pastikan Project URL & API Key Supabase sudah diterima dari pemilik produk sebelum mulai)* buat skema tabel di Supabase, ganti fungsi `get*/set*` dari localStorage ke Supabase, uji semua fitur CRUD transaksi/wallet/kategori/budget berfungsi seperti semula.
3. **Fase 2 — Kode Akses via URL**: implementasi pembuatan & pembacaan kode akses otomatis di URL, filter data Supabase berdasarkan kode akses tsb. *(checkpoint: ingatkan pemilik produk bookmark link begitu kode akses pertama kali muncul.)*
4. **Fase 3 — Web Deployment**: *(checkpoint: konfirmasi nama repository ke pemilik produk SEBELUM membuat repo baru atau push pertama kali)* setup repository GitHub, deploy ke GitHub Pages, pastikan bisa diakses publik dan berfungsi penuh.
5. **Fase 4 — Capacitor & APK**: setup Capacitor di atas source code yang sama, build APK debug, uji di HP, lanjut ke build release. *(checkpoint: begitu keystore release dibuat, ingatkan pemilik produk untuk menyimpannya dengan aman — lihat bagian 29a poin 4.)*
6. **Fase 5 — Auto-Backup & Offline Sync**: *(checkpoint: pastikan Client ID & Client Secret Google sudah diterima sebelum mulai)* implementasi backup mingguan ke Google Drive, antrian sync offline, resolusi konflik.
7. **Fase 6 — Pengujian Sinkronisasi & Finalisasi**: uji menyeluruh sinkronisasi data web ↔ APK (online & offline), perbaikan bug, dokumentasi cara pakai.

*(Antigravity boleh menyesuaikan urutan/detail fase ini selama prinsip "jangan merusak fitur yang berjalan", "perubahan bertahap dengan commit per fase", dan seluruh checkpoint di bagian 29a tetap dipegang.)*

## 31. FUTURE ROADMAP (dicatat, TIDAK dikerjakan sekarang)

- **Rekap transaksi otomatis ke Google Sheets via Google Apps Script** — daftar transaksi dikirim/disinkronkan ke spreadsheet sebagai laporan tambahan di luar aplikasi. Field "Google Sheets Web App URL" yang sudah ada di Settings disiapkan untuk fase ini. **Instruksi arsitektur untuk fase sekarang**: susun kode data layer (terutama fungsi pengambilan daftar transaksi) secara modular, supaya saat fase ini dikerjakan nanti, Antigravity tinggal menambahkan pemanggilan ke Apps Script Web App tanpa perlu merombak struktur data yang sudah ada.
- WhatsApp API untuk reminder/notifikasi.
- Kemungkinan sistem login sungguhan bila suatu saat aplikasi dipakai multi-user.

## 32. RISKS

- **Kode akses di URL bukan keamanan setara login** — risiko data terekspos jika link tidak dijaga pemilik produk. Sudah disadari dan diterima sebagai trade-off oleh pemilik produk.
- **Kuota gratis Supabase** — perlu dipastikan penggunaan tetap dalam batas gratis; project bisa "pause" otomatis setelah 7 hari tanpa aktivitas sama sekali (data tidak hilang, tinggal restore manual). Risiko ini rendah untuk pemakaian rutin, tapi perlu diperhatikan kalau lama tidak dibuka.
- **Build APK** memerlukan setup Android Studio yang cukup teknis untuk pemula — Antigravity WAJIB memandu step-by-step (lihat bagian 17).
- **Izin Google Drive untuk auto-backup** — memerlukan sign-in Google terpisah dari alur utama aplikasi; perlu dijelaskan ke user kenapa izin ini diminta supaya tidak membingungkan.
- Risiko kehilangan data yang paling nyata bukan dari server down, melainkan **human/software error** (reset tidak sengaja, bug saat pengembangan) — inilah alasan utama fitur auto-backup mingguan ke Drive (bagian 24a) penting, di luar Export manual yang sudah ada.
- **Kompleksitas sinkronisasi offline-first** — menyimpan data lokal + antrian sync + resolusi konflik (bagian 22) menambah kerumitan teknis dibanding versi "selalu online". Ini keputusan sadar demi kebutuhan pemakaian di area sinyal lemah, tapi berarti lebih banyak skenario yang perlu diuji (lihat bagian 25).
- **Row Level Security (RLS) di Supabase belum dirinci detail teknisnya di PRD ini** — kunci akses publik (anon key) aplikasi web selalu bisa dilihat siapa pun yang membuka kode sumbernya; RLS di sisi Supabase adalah lapisan pertahanan sesungguhnya yang memastikan data tetap terpisah per kode akses. Antigravity WAJIB mengonfigurasi RLS ini dengan benar, bukan hanya mengandalkan filter di sisi aplikasi.
- **Gemini API Key adalah tanggung jawab & biaya pribadi user** — pemakaian fitur AI (Scan/Analisa Saldo) memakai kuota API key milik user sendiri; kalau kuota gratis Gemini habis, fitur ini berhenti berfungsi sampai kuota reset atau user upgrade akunnya sendiri di Google AI Studio. Ini di luar kendali/tanggung jawab arsitektur aplikasi.

## 33. OPEN QUESTIONS

- Aset icon & splash screen untuk APK — belum ditentukan, perlu disiapkan sebelum build release.
- Nama produk "Catatan Keuangan" diusulkan berdasarkan judul yang sudah ada di `index.html` — perlu konfirmasi final dari pemilik produk, termasuk nama repository GitHub yang akan dipakai.
- Belum ada mekanisme "pulihkan akses" kalau kode akses/link/bookmark hilang (mis. HP hilang atau browser di-reset) selain mengandalkan file backup JSON yang tersimpan manual/otomatis — perlu disadari sebagai konsekuensi dari desain "tanpa login".

## 34. ANTIGRAVITY IMPLEMENTATION INSTRUCTIONS

Antigravity WAJIB mengikuti aturan berikut selama pengerjaan proyek ini:

1. **Jangan merusak fitur yang sudah berjalan.** Fitur di bagian 5 (Existing Features) adalah acuan wajib.
2. **Baca seluruh project sebelum mengedit** — pahami struktur yang ada sebelum membuat perubahan.
3. **Backup sebelum perubahan besar** (mis. sebelum mengganti data layer dari localStorage ke Supabase).
4. **Jangan menghapus file atau fungsi tanpa alasan yang jelas** dan didokumentasikan.
5. **Lakukan perubahan bertahap** sesuai fase di bagian 30, jangan mengerjakan semua sekaligus.
6. **Jalankan test/verifikasi fungsional setelah setiap perubahan**, sebelum melanjutkan ke langkah berikutnya.
7. **Perbaiki error yang muncul sebelum lanjut** — jangan biarkan error menumpuk atau di-skip.
8. **Commit Git per fase**, dengan pesan yang jelas dan mudah dipahami.
9. **Jangan mengerjakan fitur di luar scope** yang didefinisikan di PRD ini (lihat bagian 3, Non-Goals) tanpa persetujuan eksplisit dari pemilik produk.
10. **Dokumentasikan setiap perubahan signifikan** dengan bahasa yang sederhana, karena pemilik produk bukan programmer.
11. **Jangan menganggap build berhasil sebelum benar-benar diuji** — baik build web (GitHub Pages) maupun build APK (Capacitor).
12. **Jangan mendesain ulang UI/HTML** — tunggu file `index.html` final dari pemilik produk, fokus pada data layer, Supabase, Capacitor, dan deployment.
13. Jika ada keputusan teknis besar yang belum tercakup di PRD ini dan berdampak signifikan, **tanyakan ke pemilik produk** menggunakan bahasa sederhana (bukan istilah teknis berat) sebelum mengambil keputusan sepihak.
14. **Jalankan Pre-Flight Checklist di bagian 29a sebelum memulai apa pun, dan patuhi semua checkpoint konfirmasi di tiap fase (bagian 30).** Jangan mengarang/menebak kredensial (URL Supabase, API key, Client ID/Secret, nama repo) — selalu minta pemilik produk menempelkannya langsung.

---

## MVP Scope

- Migrasi data layer ke arsitektur **offline-first**: penyimpanan lokal di perangkat sebagai baca/tulis utama + sinkronisasi ke Supabase, tanpa mengubah fitur/perhitungan/tampilan `index.html` final.
- Semua fitur inti tetap berfungsi penuh tanpa koneksi internet (input, edit, hapus transaksi, dashboard, laporan, budget).
- Fitur AI (Scan struk & Analisa Saldo via Gemini Vision) tetap berfungsi seperti di `index.html` final — butuh internet saat dipakai (wajar, karena API eksternal), tapi tidak menghalangi fitur lain yang tetap berjalan offline.
- Sinkronisasi otomatis saat online + tombol Sync manual, dengan resolusi konflik "perubahan terakhir menang" (`updatedAt`).
- Kode akses otomatis via URL sebagai pengganti login.
- Deployment web ke GitHub Pages, memakai `index.html` final apa adanya (tanpa desain ulang).
- Build APK via Capacitor dari source code yang sama, dipakai di 1 HP, tetap bisa dipakai offline dan otomatis memakai versi terbaru begitu online.
- Export/Import data JSON manual (kini bersumber dari Supabase).
- Auto-backup JSON mingguan ke Google Drive, retensi 4 file terakhir.
- Semua fitur existing (bagian 5, termasuk AI) berfungsi tanpa regresi.

## Out of Scope

- Integrasi Google Sheets sungguhan (field URL tetap tampil, belum difungsikan).
- WhatsApp API / sistem reminder.
- Sistem login/akun multi-user.
- Desain ulang UI/HTML — `index.html` final dipakai apa adanya.

## Future Roadmap

- Rekap transaksi otomatis ke Google Sheets via Google Apps Script.
- WhatsApp API untuk reminder.
- Kemungkinan sistem login jika suatu saat multi-user.

## Acceptance Criteria

*(lihat bagian 29 di atas)*

## Definition of Done

*(lihat bagian 28 di atas)*

## Antigravity Implementation Instructions

*(lihat bagian 34 di atas)*
