# Arsitektur Keseluruhan Aplikasi Web - Catatan Keuangan
Dokumen ini menjelaskan arsitektur, modul utama, alur data, dan lingkungan teknologi (tech stack) yang digunakan untuk membangun aplikasi web Catatan Keuangan (Single Page Application).

---

## 1. Overview & Tech Stack (Teknologi Utama)

Aplikasi web Catatan Keuangan dirancang dengan pendekatan minimalis, cepat, dan mandiri (standalone) agar dapat dijalankan baik di server web hosting maupun dibuka langsung secara lokal (`file://` atau `content://` pada perangkat mobile):
*   **Vanilla Single Page Application (SPA):** Seluruh antarmuka, tata letak (CSS), dan logika aplikasi (JS) disatukan di dalam satu file utama: [`index.html`](file:///d:/04. QOSAS/PYTHON/Catatan Keuangan/index.html).
*   **Supabase JS Client SDK (CDN):** Menghubungkan frontend secara langsung ke Supabase PostgreSQL database menggunakan pustaka `@supabase/supabase-js`. Keamanan data diisolasi menggunakan filter `access_code`.
*   **Chart.js (Bundled Offline):** Pustaka visualisasi grafik yang dibundel secara inline di dalam HTML agar grafik analisis keuangan tetap dapat dirender tanpa koneksi internet.
*   **Google Fonts & Icons:** Menggunakan font Google Fonts (seperti Inter/Outfit) dan ikon dinamis untuk estetika premium modern.

---

## 2. Struktur Modul Utama Aplikasi Web

Aplikasi web ini memiliki beberapa modul manajemen keuangan interaktif yang tersinkronisasi langsung dengan database Supabase:

### A. Dashboard & Ringkasan Keuangan
*   **Overview Balances:** Menampilkan total saldo gabungan seluruh dompet serta breakdown saldo per-dompet (misal: Dompet Utama, Dompet Tabungan).
*   **Financial Charts:** Grafik batang/lingkaran Chart.js yang membandingkan total pemasukan vs pengeluaran bulanan serta breakdown pengeluaran berdasarkan kategori.
*   **Real-time Budget Alerts:** Menampilkan progress bar limit anggaran kategori, memberikan peringatan visual (warna kuning/merah) saat pengeluaran mendekati atau melebihi batas limit.

### B. Manajemen Transaksi (Transactions)
*   **CRUD Transaksi:** Pengguna dapat menambah, mengedit, dan menghapus transaksi pemasukan (`income`), pengeluaran (`expense`), dan transfer saldo antar-dompet (`transfer`).
*   **Source Identifier:** Kolom `source` pada tabel `transactions` membedakan apakah entri dibuat langsung melalui aplikasi web (`app`) atau secara otomatis via WhatsApp bot (`whatsapp`).

### C. Anggaran Bulanan (Limit/Budgets)
*   Mengatur batas pengeluaran maksimum per-kategori per-bulan (`YYYY-MM`). Progress bar terhitung otomatis dari akumulasi transaksi pengeluaran kategori terkait pada bulan berjalan.

### D. Tagihan Rutin (Checklist/Recurring Items)
*   Mendaftar tagihan bulanan (seperti listrik, kuota, kos, SPP) beserta tanggal jatuh tempo.
*   Menyediakan tombol aksi cepat untuk menandai tagihan sebagai "Lunas" (menghasilkan entri transaksi otomatis dan memperbarui kolom `last_confirmed_date` menjadi bulan berjalan).

### E. Target Tabungan (Savings Goals)
*   Mengelola tujuan keuangan yang ditautkan ke dompet khusus (rekening tabungan). Menghitung persentase pencapaian target secara real-time berdasarkan saldo dompet terkait.

### F. Utang & Piutang (Debt Entries)
*   Mencatat daftar utang saya (`i_owe`) dan piutang orang lain (`owed_to_me`) per-orang.
*   Mendukung pencatatan pembayaran sebagian (cicilan) atau pelunasan penuh.

### G. Konfigurasi Navigasi & Pengaturan User
*   **User Settings Table:** Mengelola saldo awal (`initialBalances`), pengaturan urutan dompet, dan kustomisasi pintasan (shortcut).
*   **Insight & Analysis Cache:** Menyimpan cache analisis keuangan berkala di kolom JSONB (`insight_cache` & `analysis_cache`) untuk meningkatkan performa muat halaman (startup speed) tanpa kueri berat berulang.

---

## 3. Sistem Keamanan & Akses Data (Multi-User Isolation)

Aplikasi web ini menggunakan sistem akses berbasis kode akses unik (**Access Code**):
1.  **Format Query Parameter:** Akses ke aplikasi web dilakukan melalui parameter URL unik:
    `https://muhqosaswardani.github.io/catatan_keuangan/?akses=ak_jc3lbk4`
2.  **Pemisahan Data (Data Isolation):** Di sisi klien, JavaScript mengambil nilai parameter `akses` tersebut sebagai kunci enkripsi/identifikasi. Setiap kueri baca dan tulis (SELECT, INSERT, UPDATE, DELETE) ke semua tabel Supabase wajib difilter dengan klausa:
    `.eq('access_code', accessCode)`
3.  **Sinkronisasi dengan WhatsApp:** Kode akses `access_code` ini sama persis dengan yang dikonfigurasi pada environment variable WhatsApp webhook (`WA_ACCESS_CODE`), sehingga transaksi yang diinput dari web maupun dari WhatsApp bot tersinkronisasi sempurna pada satu profil pengguna yang sama.

---

## 4. Alur Kerja Sinkronisasi Data (Data Flow)

```
       Aplikasi Web (index.html)                WhatsApp Bot (Edge Function)
                 │                                        │
                 ▼ (Query: eq access_code)                ▼ (Query: eq access_code)
         ┌────────────────────────────────────────────────────────┐
         │                                                        │
         │             Database Supabase (PostgreSQL)             │
         │                                                        │
         └────────────────────────────────────────────────────────┘
                                 ▲
                                 │ (Sync Real-time)
                                 ▼
                     Dasboard Visual & Grafik
```
*   **Web-to-Database:** Setiap input transaksi baru dari dashboard web akan langsung mengupdate saldo dompet (`wallets`) dan tabel transaksi terkait.
*   **WA-to-Database:** Setiap transaksi yang dikirim user via WhatsApp bot akan ditulis ke database. Begitu pengguna membuka/me-refresh halaman web, dashboard akan langsung menampilkan data transaksi terbaru tersebut secara real-time.
