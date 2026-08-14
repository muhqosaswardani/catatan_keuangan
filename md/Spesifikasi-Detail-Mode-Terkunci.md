# Spesifikasi Detail — Alur 3 Mode Terkunci (Koreksi, Limit, Tujuan)
**Dokumen perbaikan bug implementasi Fase 8**
Dibuat: 14 Agustus 2026 — pelengkap teknis dari `PRD-WA-Tahap2-v2.md` bagian 5.5–5.8

*Dokumen ini dibuat karena hasil pengujian implementasi saat ini TIDAK sesuai spesifikasi PRD — lihat bagian 0. Gunakan dokumen ini sebagai acuan detail step-by-step untuk membangun ulang bagian yang salah, TANPA mengubah bagian arsitektur lain yang sudah benar (router urutan, isolasi V2, dsb — tetap ikuti `Arsitektur-WA-Bot.md`).*

---

## 0. BUG YANG DITEMUKAN — WAJIB DIPERBAIKI DULU

Dari hasil pengujian nyata (screenshot), ditemukan 2 bug fatal:

### Bug 1 — Mode "koreksi" langsung mengeksekusi transaksi nyata, bukan draft
Saat user kirim foto di dalam mode `koreksi`, sistem **langsung membuat transaksi sungguhan** (kategori "Penyesuaian Saldo", saldo dompet langsung berkurang) — TANPA menampilkan laporan analisis dulu dan TANPA menunggu konfirmasi `ya`/`oke`.

**Ini salah total.** Sesuai PRD 5.6, foto/nilai yang dikirim dalam mode koreksi HARUS diproses sebagai **draft di dalam session** (`wa_mode_sessions.session_data`), bukan lewat pipeline transaksi V1. Perubahan ke database (`wallets`, `transactions`) HANYA BOLEH terjadi setelah user ketik `ya`/`oke`.

### Bug 2 — Kata "batal" di dalam mode tidak dikenali, malah menghapus transaksi terakhir
Di kedua contoh (mode koreksi & mode limit), setelah user ketik `batal`, sistem membalas **"Transaksi terakhir dihapus"** — ini perilaku fallback V1 ("hapus transaksi terakhir"), BUKAN perilaku keluar mode yang seharusnya.

**Ini mengindikasikan session mode sama sekali tidak dicek sebagai prioritas utama.** Pesan `batal` (dan kemungkinan semua pesan lain di dalam mode) lolos begitu saja ke jalur fallback V1, alih-alih ditangkap oleh handler mode terlebih dulu.

### Akar masalah yang harus dicek Antigravity
1. Apakah `wa_mode_sessions` benar-benar ter-*insert*/ter-*update* saat user masuk mode (`getSession`/`saveSession` di `v2_db.ts` benar-benar dipanggil dan berhasil)?
2. Apakah **step 0 di router (`v2_router.ts`) — cek sesi mode aktif — benar-benar dieksekusi PALING PERTAMA**, sebelum request diteruskan ke handler manapun (termasuk sebelum V1 fallback, sebelum media queue V1, sebelum parser transaksi V1)? Ini harus jadi *hard gate*: kalau ada sesi aktif untuk `wa_chat_id` tsb, request WAJIB berhenti di handler mode dan TIDAK BOLEH diteruskan ke kode lain apapun.
3. Apakah foto yang dikirim user selagi mode aktif malah tertangkap duluan oleh **Media Batch Queue V1** (`wa_media_queue`, window 3 detik) sebelum sempat dicek statusnya "sedang dalam mode"? Kalau iya, urutan ini juga salah — pengecekan sesi mode harus terjadi SEBELUM pesan/media apapun (termasuk foto) di-enqueue ke jalur V1.

**Perbaikan wajib**: pindahkan pengecekan `wa_mode_sessions` ke titik paling awal di seluruh alur pemrosesan pesan masuk — sebelum idempotensi selesai diverifikasi cukup, sebelum media di-enqueue ke V1, sebelum parser apapun dipanggil. Kalau sesi aktif ditemukan, SELURUH pesan (teks maupun foto) diteruskan ke handler mode terkait dan alur berhenti di situ — tidak ada percabangan lain yang boleh memproses pesan itu.

---

## 1. Prinsip Umum (recap wajib — tidak berubah dari PRD)

- **Trigger masuk mode**: exact match, case-insensitive. `koreksi` | `limit`/`anggaran` | `tujuan`/`goals` | `help`/`bantuan`/`menu`.
- **Mode-lock total**: begitu di dalam mode, SEMUA pesan (apapun jenisnya — teks, foto, VN) diproses HANYA dalam konteks mode itu. Tidak ada pengecualian, tidak ada fallback ke V1, sampai user keluar (via `batal`, `ya`/`oke`, atau timeout).
- **Kata universal, prioritas tertinggi di dalam mode**:
  - `batal` (exact) — keluar mode, **TIDAK ADA PERUBAHAN DATA SAMA SEKALI** (tidak ada insert/update/delete apapun ke `wallets`, `transactions`, `budgets`, savings goal, ATAU tabel lain manapun).
  - `ya` / `oke` (fleksibel) — konfirmasi final, baru di titik INI perubahan data sungguhan boleh terjadi.
- **Timeout**: 5 menit tanpa aktivitas → auto keluar mode, tanpa efek data apapun (sama seperti `batal`).
- **Ambiguitas nama** (dompet/kategori/goal match >1 kandidat) → wajib tanya klarifikasi dulu.

---

## 2. Mode "koreksi" — Alur Step-by-Step (REVISI, wajib diikuti persis)

### State session (`wa_mode_sessions.session_data` untuk mode koreksi)
```json
{
  "step": "pilih_dompet | kumpul_data | siap_konfirmasi",
  "items": [
    { "no": 1, "wallet_id": "w_gopay_123", "wallet_label": "GoPay", "nilai_aktual": 16300, "sumber": "teks" },
    { "no": 2, "wallet_id": "w_cash_001", "wallet_label": "Cash", "nilai_aktual": 36600, "sumber": "foto" }
  ]
}
```
**Catatan penting**: `items` ini HANYA ada di kolom JSONB session, BUKAN di tabel `transactions`. Tidak ada baris baru di `transactions` atau perubahan `wallets.balance` sampai step konfirmasi (langkah 6) selesai.

### Langkah-langkah
1. **Masuk mode**: user ketik `koreksi` (exact) → buat/replace session (`mode = 'koreksi'`, `session_data = { step: 'pilih_dompet', items: [] }`) → balas: penjelasan mode + cara keluar (`batal`) — **format sesuai contoh yang sudah jalan di screenshot, ini sudah benar**.
2. **Pilih dompet** (kalau user punya >1 dompet): tanya dompet mana yang mau dikoreksi dulu, ATAU user boleh langsung kirim foto/teks yang menyebut nama dompetnya sendiri (skip pertanyaan ini kalau sudah jelas dari input pertama).
3. **Terima input** (foto dan/atau teks, boleh berkali-kali dalam 1 sesi):
   - Foto → Gemini Vision membaca nominal uang cash dari gambar → hasilnya masuk sebagai draft `items` baru (dengan `sumber: "foto"`), **BUKAN dibuat transaksi**.
   - Teks nominal (mis. "gopay 50rb", "cash 20rb") → Gemini ekstrak dompet + nominal → masuk sebagai draft `items` baru (`sumber: "teks"`), **BUKAN dibuat transaksi**.
   - Kalau AI tidak berhasil mendeteksi indikasi nominal yang jelas dari foto/teks → tanya ulang, JANGAN lanjut ke langkah 4 dulu.
4. **Render laporan draft** (1 bubble, di-update ulang setiap kali ada perubahan `items`):
   ```
   📋 Draft Koreksi Saldo

   1. Cash
      Saldo sistem : Rp196.467
      Saldo aktual : Rp160.467
      Selisih      : -Rp36.000

   2. GoPay
      Saldo sistem : Rp10.000
      Saldo aktual : Rp16.300
      Selisih      : +Rp6.300

   Ketik nama/nomor + nilai baru untuk edit, "tambah [dompet] [nilai]" untuk tambah dompet lain, "hapus [nomor/nama]" untuk hapus salah satu.

   Ketik "ya" untuk proses semua koreksi di atas, atau "batal" untuk keluar tanpa perubahan.
   ```
   `Saldo sistem` diambil dari `wallets.balance` SAAT INI (read-only, query biasa, bukan hasil hitungan Gemini). `Selisih` dihitung deterministik (kode biasa), bukan oleh Gemini.
5. **User lanjut interaksi** (masih di langkah 4, bisa berkali-kali):
   - `tambah [dompet] [nilai]` → tambah item baru ke `items`, render ulang laporan.
   - `[nomor]` atau `[nama dompet] [nilai baru]` (mis. "gopay 16.300" atau "2 16.300") → replace nilai item yang match, render ulang laporan. Match berdasarkan kecocokan value nama dompet, bukan harus string identik.
   - `hapus [nomor/nama]` → hapus item dari draft, render ulang laporan.
   - Kalau nama dompet match >1 kandidat → tanya klarifikasi dulu, jangan asal pilih.
6. **Konfirmasi `ya`/`oke`**:
   - Untuk SETIAP item di `items`: buat 1 transaksi penyesuaian (kategori "Penyesuaian Saldo") dengan nominal = selisih, DAN update `wallets.balance` dompet terkait ke nilai aktual.
   - Setelah semua item diproses: **hapus session** (keluar mode otomatis, TIDAK loop tanya lagi — beda dari mode limit/tujuan).
   - Balas notifikasi ringkasan saldo terbaru semua dompet yang dikoreksi.
7. **`batal`** (kapan saja, di langkah manapun sebelum langkah 6 selesai): hapus session, balas konfirmasi singkat "Mode koreksi dibatalkan, tidak ada perubahan data." — **TIDAK ADA satupun baris di `transactions`/`wallets` yang tersentuh.**

### Aturan tegas
> **Sebelum user ketik `ya`/`oke`, TIDAK BOLEH ada satu pun write ke `transactions` atau `wallets` yang terjadi akibat mode koreksi.** Semua foto/teks yang masuk selama mode aktif diproses SEPENUHNYA sebagai manipulasi `session_data.items` (baca: hanya update kolom JSONB di `wa_mode_sessions`), sampai konfirmasi final.

---

## 3. Mode "limit"/"anggaran" — Alur + Format Tampilan Baru

### Format tampilan daftar (REVISI — dropdown per kategori, bukan 1 baris)

**Sebelumnya (salah, terlalu padat 1 baris)**:
```
1. Makan: Rp1.200.000 (Terpakai: Rp304.460, Sisa: Rp895.540)
```

**Sekarang (format yang diminta — dropdown ke bawah per kategori)**:
```
Daftar Limit Anggaran (Agustus 2026):

1. Makan
   Limit    : Rp1.200.000
   Terpakai : Rp304.460
   Sisa     : Rp895.540

2. Transport
   Belum ada limit

3. Belanja
   Limit    : Rp100.000
   Terpakai : Rp0
   Sisa     : Rp100.000

4. Tagihan
   Belum ada limit

...

Mau tambah, edit, atau hapus yang mana?
```
- Kategori yang belum punya limit cukup ditulis "Belum ada limit" (tanpa baris Terpakai/Sisa).
- Kategori yang sudah punya limit selalu tampilkan 3 baris: Limit, Terpakai, Sisa.
- Kalau pesan jadi panjang dan WA menampilkan "Baca selengkapnya" (terpotong otomatis oleh klien WA) — ini perilaku normal WhatsApp untuk pesan panjang, BUKAN bug, tidak perlu diakali.

### Alur (tidak berubah dari PRD, ditegaskan ulang)
1. Masuk mode (`limit`/`anggaran`, exact) → buat session → tampilkan daftar lengkap format di atas → tanya "mau tambah/edit/hapus yang mana?".
2. **Edit**: sebut nomor/nama kategori + nominal baru → replace nominal bulan berjalan (bukan akumulasi) → render ulang konfirmasi perubahan → loop ke langkah 1 (tanya "mau apa lagi?").
3. **Tambah**: sebut nama kategori baru + nominal → insert limit baru bulan berjalan → loop.
4. **Hapus**: sebut nomor/nama kategori → hapus baris limit kategori itu (transaksi historis TETAP ADA, tidak ikut terhapus) → loop.
5. **`batal`** (kapan saja) → hapus session, keluar mode, **TIDAK ADA perubahan data apapun** (termasuk tidak boleh menyentuh transaksi apapun, apalagi "transaksi terakhir" yang sama sekali tidak terkait mode ini — ini yang jadi Bug 2 di atas).

---

## 4. Mode "tujuan"/"goals" — Alur + Format Tampilan (mirror dari mode limit)

### Format tampilan
```
Daftar Tujuan Tabungan:

1. Dana Darurat
   Target     : Rp10.000.000
   Terkumpul  : Rp3.500.000 (35%)
   Sisa       : Rp6.500.000

2. Laptop Baru
   Target     : Rp15.000.000
   Terkumpul  : Rp2.000.000 (13%)
   Sisa       : Rp13.000.000

Mau tambah, edit, atau hapus yang mana?
```

### Alur (identik pola dengan mode limit)
1. Masuk mode (`tujuan`/`goals`, exact) → tampilkan daftar lengkap format di atas → tanya mau tambah/edit/hapus.
2. **Edit**: nomor/nama goal + target baru (atau field lain yang mau diubah) → update → loop.
3. **Tambah**: nama goal baru + target nominal → insert goal baru → loop.
4. **Hapus**: nomor/nama goal → hapus baris goal itu (transaksi historis terkait TETAP ADA) → loop.
5. **`batal`** → hapus session, keluar mode, **TIDAK ADA perubahan data apapun**.

---

## 5. Checklist Regresi — WAJIB Diuji Ulang Sebelum Lanjut

- [ ] Masuk mode `koreksi`, kirim foto → pastikan **saldo dompet TIDAK berubah** dan **TIDAK ada baris baru di `transactions`** sampai user ketik `ya`.
- [ ] Di dalam mode `koreksi`, ketik `batal` → pastikan **tidak ada transaksi apapun yang terhapus/berubah** (termasuk transaksi lama yang tidak terkait mode ini sama sekali).
- [ ] Di dalam mode `limit`, ketik `batal` segera setelah daftar limit muncul → pastikan **tidak ada transaksi terhapus** (ulangi skenario yang gagal di screenshot: "mie ayam" tidak boleh ikut terhapus).
- [ ] Format daftar limit tampil dropdown per kategori (Limit/Terpakai/Sisa masing-masing baris sendiri), bukan 1 baris padat.
- [ ] Format daftar tujuan tampil dropdown serupa (Target/Terkumpul/Sisa).
- [ ] Kirim foto di dalam mode `koreksi` → pastikan foto TIDAK ikut ke-enqueue ke `wa_media_queue` (jalur V1), melainkan langsung ditangani handler mode.
- [ ] Setelah `ya` di mode koreksi: verifikasi saldo dompet & transaksi baru sesuai draft terakhir yang ditampilkan (bukan draft versi awal kalau sempat diedit).
- [ ] Ulangi uji timeout 5 menit untuk ketiga mode — pastikan juga tidak ada perubahan data saat timeout.
