# Arsitektur Keseluruhan WhatsApp Bot - Catatan Keuangan
Dokumen ini menjelaskan arsitektur sistem, alur kerja (workflow), skema database, dan integrasi kecerdasan buatan (Gemini AI) yang digunakan untuk membangun bot WhatsApp Catatan Keuangan, mencakup **Fase 1 (Tahap 1 - Dasar)** dan **Fase 2 (Tahap 2 - Peningkatan)**.

---

## 1. Overview & Lingkungan Teknologi (Tech Stack)

Bot WhatsApp terintegrasi langsung dengan aplikasi Catatan Keuangan berbasis web menggunakan teknologi serverless dan AI:
*   **WhatsApp Cloud API (Meta API):** Endpoint untuk menerima webhook pesan masuk dan mengirim balasan pesan (teks & media).
*   **Supabase Edge Functions (Deno Runtime):** Engine backend serverless yang memproses pesan secara real-time, stateless, dan cepat.
*   **Supabase Database (PostgreSQL):** Penyimpanan persisten untuk transaksi, dompet, kategori, anggaran, checklist, utang-piutang, serta session data bot.
*   **Google Gemini API (Model: gemini-3.5-flash / fallback):** Digunakan untuk Natural Language Processing (NLP) untuk parsing teks transaksi bebas, analisis visual foto struk/uang cash (Gemini Vision), perangkaian laporan bahasa alami, dan deteksi intent aksi.

---

## 2. Diagram Alur Webhook & Router Pesan
Setiap pesan WhatsApp yang masuk akan diarahkan melalui alur penyaringan (routing) bertahap berikut:

```
                  Pesan WA Masuk
                        │
                        ▼
          [ Verifikasi Signature Hub ]
                        │
                        ▼
         [ Idempotensi: claimMessage ] (Cegah proses ganda)
                        │
                        ▼
         ┌──────────────┴──────────────┐
         │  YA                         │ TIDAK (Bypass V2)
         ▼                             ▼
  [ WA_V2_ENABLED === "true" ]       [ Alur Versi 1 (Fase 7) ]
         │                             │ - Reply ke bubble tx?
         │ YA                          │ - Cek saldo / hapus terakhir?
         ▼                             │ - handleTextMessage (AI Parse)
 0. Cek Sesi Mode Terkunci             │ - VN / Photo queue
    (wa_mode_sessions)?                │
   ├─► YA: Cek Timeout (5 menit)?      │
   │       ├─► YA: Sesi kedaluwarsa, hapus sesi, kirim notifikasi,
   │       │       dan INTERSEPT pesan (kembalikan true) agar tidak bocor ke V1.
   │       └─► TIDAK: Proses dalam mode aktif. Blokir intent lain / konfirmasi keluar.
   │
   └─► TIDAK: Lanjut ke step 1
         │
         ▼
 1. Cek Exact Match Trigger Mode:
    "koreksi" | "limit" | "tujuan" | "help"
   ├─► YA: Masuk mode terkunci terkait.
   └─► TIDAK: Lanjut ke step 2
         │
         ▼
 2. Cek Reply ke Klarifikasi V2
    (wa_pending_transactions)?
   ├─► YA: Selesaikan pilihan (1, 2, dst).
   └─► TIDAK: Lanjut ke step 3
         │
         ▼
 3. Router Intent Teks Bebas V2 (Gemini Parse):
    a. Checklist/Tagihan Lunas (Match semantik due/overdue)
    b. Transfer Antar Dompet
    c. Aksi Utang-Piutang (Baru, cicilan, lunas, overpayment)
   ├─► YA (Match salah satu): Eksekusi aksi V2.
   └─► TIDAK: Lanjut ke step 4
         │
         ▼
 4. Cek Query Laporan / Cek Saldo:
    (Mengandung "?" ATAU kalimat "cek saldo")
   ├─► YA: Jalankan V2 Query (Deterministik + Gemini Packaging).
   └─► TIDAK: Fallback ke V1
         │
         ▼
 5. FALLBACK ke Alur Versi 1 (Fase 7)
    - Cek reply edit/delete transaksi lama.
    - Cek VN/Foto queue batching.
    - Parsing transaksi baru biasa.
```

---

## 3. Komponen Arsitektur Fase 1 (Stage 1 - Fase 7)
Fase 1 meletakkan fondasi integrasi WhatsApp dengan fitur-fitur dasar:
*   **Gemini Transaction Parser:** Menerjemahkan kalimat bebas bahasa Indonesia sehari-hari, singkatan gaul (misal: "nasgor 15k", "bensin ceban"), menjadi objek JSON terstruktur berisi kategori, nominal, tipe, dompet, dan catatan.
*   **Media Batch Queue (`wa_media_queue`):** Mengelompokkan pengiriman beberapa foto struk atau VN berturut-turut dalam window 3 detik untuk dikirim sekaligus ke Gemini API (menghindari duplikasi parsing).
*   **Pending Nominal (`wa_pending_transactions`):** Jika transaksi bernilai 0 (nominal tidak kebaca) atau note generik, bot menahan transaksi di tabel pending dan bertanya ke user. Jawaban berikutnya (baik reply bubble maupun pesan baru) akan melengkapi data pending tersebut.
*   **Reply-to-Edit/Delete:** User bisa membalas (reply) ke bubble konfirmasi bot dengan pesan "hapus" untuk men-delete transaksi tersebut, atau mengirim koreksi (misal "nominalnya 20rb") untuk mengupdate detail transaksi.

---

## 4. Komponen Arsitektur Fase 2 (Stage 2 - Fase 8)
Fase 2 memperluas bot menjadi asisten keuangan pintar dengan kendali presisi tinggi:

### A. Mekanisme Rollback 1-Flag
Semua file baru untuk Stage 2 diisolasi dengan prefix `v2_` (`v2_router.ts`, `v2_modes.ts`, `v2_query.ts`, `v2_intents.ts`, `v2_db.ts`). Aktivasinya dikendalikan oleh satu variabel lingkungan di Supabase: `WA_V2_ENABLED`. Jika bernilai `false`, endpoint akan langsung mem-bypass router V2.

### B. Mode Terkunci (Mode-Lock State)
Mengunci konteks obrolan menggunakan state sesi di tabel `wa_mode_sessions` untuk mencegah bocornya pesan ke parser transaksi bebas selama input data sensitif:
1.  **Mode Koreksi Saldo:**
    *   **Pilihan Dompet Bernomor (Langkah 1):** Dompet disajikan dalam daftar bernomor. Mendukung shortcut `"semua"` atau `"all"` untuk memilih seluruh dompet.
    *   **Breakdown & Akun Sub-Ewallet (Langkah 2):** Mendeteksi multi-foto screenshot m-banking dan e-wallet secara bersamaan. AI secara otomatis mengurai saldo sub-akun (seperti DANA, GoPay, OVO, ShopeePay, LinkAja, dll) dan memetakan nominalnya ke dompet utama database yang sesuai (misal: e-wallet dipetakan ke `Dompet Utama`).
    *   **Layout Rekap Terstruktur:** Balasan bot menyajikan rincian bullet-point sub-akun yang terbaca, total saldo aktual, total saldo tercatat di aplikasi, serta nominal selisih penyesuaian yang akan dibuat.
2.  **Mode Limit/Anggaran:** Menampilkan daftar limit kategori bulan berjalan (`YYYY-MM`) terurut dengan **kategori berlimit di bagian atas**. Mengizinkan perintah edit (mengganti limit penuh), tambah limit, atau hapus limit.
3.  **Mode Tujuan Tabungan:** Menampilkan daftar target tabungan dan progress-nya terurut dengan **tujuan memiliki target di bagian atas**. Mengizinkan edit target, tambah tujuan, atau hapus tujuan.

### C. Concurrency Control & Perlindungan Balasan Ganda
*   **Optimistic Concurrency Control (OCC) Retries:** Saat menerima unggahan multi-foto sekaligus, webhook paralel akan berebut menulis ke sesi. Menggunakan validasi token timestamp `updated_at` dengan loop retries untuk memastikan semua input foto berhasil masuk ke antrean `pending_batch_inputs` tanpa saling menimpa.
*   **OCC Claim:** Worker background yang memproses batch antrean setelah jeda hening akan mencoba melakukan klaim (mengosongkan antrean sesi dengan filter timestamp). Hanya tepat **satu worker** yang berhasil mengklaim dan mengirimkan gelembung draft rekap tunggal ke user.
*   **Umpan Balik Status:** Jika dari foto/pesan tidak terdeteksi nominal saldo untuk dompet terpilih, bot tidak akan diam saja (silent), melainkan mengirimkan gelembung bantuan.

### D. Penanganan Memori & Crash Media (Safe Base64 Encoding)
File media (gambar screenshot HP, VN panjang) yang diunduh berukuran >65KB akan mengalami stack overflow jika dikonversi menggunakan operator spread parameter `String.fromCharCode(...bytes)` di Deno. Sistem menggantinya dengan fungsi `safeBytesToBase64` yang memproses biner secara bertahap dalam potongan 16KB (chunked encoding), menjamin bot bebas crash system-wide.

### E. Perlindungan Kebocoran Sesi Timeout
Jika sesi melewati batas waktu (5 menit tanpa aktivitas), router V2 akan secara otomatis menghapus sesi, mengirim pesan pemberitahuan timeout, dan langsung **mengintersept pesan pemicu** (mengembalikan `true`), mencegah pesan tersebut bocor ke parser V1 (misal ketikan `"batal"` yang tidak sengaja menghapus transaksi).

### F. Router Intent Teks Bebas V2
Mendeteksi 3 intent baru secara fleksibel (menggunakan Gemini) dengan urutan prioritas:
1.  **Checklist Lunas:** Item tagihan jatuh tempo/terlambat dicocokkan secara semantik menggunakan Gemini. Jika match > 1 item due, bot meminta klarifikasi. Nominal dicari otomatis dari histori transaksi serupa.
2.  **Transfer Saldo:** Memotong saldo dompet asal dan menambahkan ke dompet tujuan.
3.  **Utang Piutang:**
    *   Jika nominal bayar < sisa utang berjalan: otomatis dicatat sebagai **cicilan**.
    *   Jika nominal bayar = sisa utang: otomatis dicatat sebagai **lunas**.
    *   Jika nominal bayar > sisa utang: utang lama lunas, dan kelebihannya otomatis dibuatkan catatan **utang baru dengan tipe berlawanan (Reverse Debt)**.
    *   Jika orang tersebut memiliki > 1 entri utang aktif terpisah, sistem memicu **wajib klarifikasi** berupa pilihan entri mana yang ingin dibayar.

### G. Sistem Query Anti-Halusinasi
Saat user menanyakan laporan (bertanda tanya `?`), sistem membagi pemrosesan menjadi 2 tahap:
1.  **Tahap Deterministik (TypeScript):** Backend mengkueri database dan menghitung seluruh metrik keuangan secara pasti (total pengeluaran, sisa budget tiap kategori, rata-rata harian, sisa utang-piutang, progres goal tabungan).
2.  **Tahap Bahasa (Gemini AI):** Data hasil kalkulasi terstruktur dikirim ke Gemini bersama pertanyaan user. Gemini diinstruksikan ketat hanya merangkai data angka tersebut menjadi kalimat alami, tanpa boleh menghitung atau mengarang angka sendiri.

---

## 5. Struktur Database Pendukung WhatsApp

Tabel-tabel khusus di database PostgreSQL Supabase untuk mendukung fungsionalitas bot WA:

```sql
-- 1. Idempotensi Webhook (Cegah pemrosesan ulang pesan ganda dari Meta)
CREATE TABLE public.wa_processed_messages (
    wa_message_id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Mapping Pesan WA <-> Transaksi (Mendukung Reply-to-Edit & Reply-to-Delete)
CREATE TABLE public.wa_message_transactions (
    wa_message_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL, -- Dapat berupa ID Transaksi (wa_tx_) atau ID Utang (wa_debt_)
    access_code TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Transaksi Pending (Menahan data sementara saat menunggu nominal/keterangan dari user)
CREATE TABLE public.wa_pending_transactions (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    wa_chat_id TEXT NOT NULL,
    wa_question_message_id TEXT,
    pending_data JSONB NOT NULL, -- Menyimpan data draft transaksi atau pilihan kandidat klarifikasi
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Queue Media Masuk (Batching multi-foto dan voice note lintas serverless invocation)
CREATE TABLE public.wa_media_queue (
    wa_message_id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    wa_chat_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    media_kind TEXT CHECK (media_kind IN ('image', 'audio')),
    caption TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ
);

-- 5. Sesi Mode Terkunci V2 (Menyimpan status dan draft item selama dalam Mode Koreksi/Limit/Tujuan)
CREATE TABLE public.wa_mode_sessions (
    wa_chat_id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    mode TEXT, -- 'koreksi', 'limit', 'tujuan'
    session_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Log Aktivitas Real-time Webhook (Penyimpanan logs audit Edge Function)
CREATE TABLE public.wa_logs (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 6. Integrasi Logika Reversibilitas (Revert Actions)
Mekanisme reply-to-delete V1 diperluas ke semua aksi transaksi V2:
*   **Jika Transfer Dihapus:** Transaksi transfer dihapus, saldo kedua dompet disesuaikan kembali secara otomatis.
*   **Jika Checklist Dihapus:** Transaksi pembayaran dihapus, dan kolom `last_confirmed_date` pada item checklist (`recurring_items`) di-reset kembali menjadi `null` agar tagihan kembali berstatus belum lunas.
*   **Jika Pembayaran Utang Dihapus:**
    *   Apabila sebelumnya lunas penuh: entri utang diaktifkan kembali (`status = 'active'`), payoff details dikosongkan, dan jika ada entri kelebihan bayar (reverse debt), entri tersebut ikut dihapus dari DB.
    *   Apabila sebelumnya cicilan: nominal pembayaran ditambahkan kembali ke jumlah utang aktif yang ada.
*   **Jika Entri Utang Baru Dihapus:** Entri di tabel `debt_entries` langsung dihapus secara permanen.
