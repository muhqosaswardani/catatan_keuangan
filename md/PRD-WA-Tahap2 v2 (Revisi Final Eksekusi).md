# PRD — Catatan Keuangan: WA Peningkatan Tahap 2 ("Versi 2")
**Fase 8 — Dokumen kerja untuk Antigravity IDE**
Versi: 2.0 · Direvisi: 14 Agustus 2026 (revisi dari v1.0, 13 Agustus 2026)

*Dokumen ini adalah lanjutan/addendum dari `PRD-Catatan-Keuangan.md` (Fase 1–6) dan `PRD-WhatsApp-Integration.md` (Fase 7, integrasi WA dasar: catat transaksi via teks/foto/VN, cek saldo, hapus transaksi terakhir, reply-to-edit/delete). Fase ini menambahkan kemampuan baru di atas fondasi Fase 7 yang sudah berjalan baik — TANPA mengubah cara kerja fondasi itu.*

**Ringkasan perubahan v2.0 vs v1.0**: logic pencocokan checklist & utang-piutang diperjelas (bagian 5.3, 5.4); ubah limit budget lewat teks bebas (v1.0 bagian 5.5) DIHAPUS dan digantikan sistem **mode terkunci** dengan trigger kata eksak (bagian 5.5–5.9) yang juga menambahkan 2 kemampuan baru: penyesuaian saldo ("koreksi", setara fitur "Cek" di web) dan kelola tujuan tabungan via WA — keduanya belum ada di v1.0.

---

## 0. PRINSIP UTAMA: INI ADALAH "VERSI 2" YANG WAJIB BISA DI-ROLLBACK

Ini instruksi paling penting di seluruh dokumen ini, WAJIB dipahami dan diikuti Antigravity sebelum menulis kode apa pun:

- Semua fitur di PRD ini (mulai bagian 5 dan seterusnya) disebut **"Versi 2"**.
- Fitur inti dari Fase 7 (catat transaksi via teks/foto/VN, cek saldo, hapus transaksi terakhir, reply-to-edit/delete untuk transaksi) disebut **"Versi 1" / fondasi**, dan **TIDAK BOLEH diubah/disentuh strukturnya** untuk mengakomodasi Versi 2.
- **Versi 2 WAJIB dibangun sebagai lapisan/modul TERPISAH yang jelas** dari kode Versi 1 — bukan disisipkan tercampur ke dalam logic Versi 1. Semua kode Versi 2 (fungsi baru, prompt tambahan, routing tambahan, state mode) harus **ditandai jelas** (mis. nama file/fungsi berawalan `v2` atau komentar eksplisit `// VERSI 2` di setiap bagian terkait).
- **Tujuan penandaan ini**: kalau di kemudian hari logic Versi 2 ternyata berantakan/tidak sesuai harapan, pemilik produk cukup bilang **"hapus Versi 2"**, dan Antigravity harus bisa **mencabut/menonaktifkan seluruh modul Versi 2 itu SAJA** (termasuk semua mode terkunci di bagian 5.5–5.9), sehingga aplikasi otomatis kembali ke perilaku Versi 1 (fondasi Fase 7) yang sudah terbukti jalan baik — tanpa perlu bongkar ulang fondasi.
- Cara teknis yang disarankan (Antigravity boleh menyesuaikan implementasinya, prinsip ini yang wajib dipegang): pesan masuk dari WA dicek dulu lewat **router intent Versi 2** (modul terpisah, termasuk pengecekan mode aktif) — kalau tidak ada satupun intent/mode Versi 2 yang cocok, baru diteruskan ke alur Versi 1 seperti biasa (fallback). Router Versi 2 ini idealnya bisa dimatikan lewat 1 flag/konfigurasi tunggal, bukan dengan menghapus banyak potongan kode tersebar.

## 1. OVERVIEW

Menambahkan kemampuan baru ke bot WhatsApp Catatan Keuangan:

1. **Query bebas (baca) atas SEMUA data/laporan yang ada di aplikasi web** — sisa anggaran, kategori apa saja yang ada, pengeluaran terbesar bulan ini, total pemasukan/pengeluaran per periode, progress tujuan tabungan, daftar utang/piutang, dsb. **Prinsip: kalau di web ada fiturnya, di WA pasti bisa ditanyakan, tanpa terkecuali.**
2. **Transfer antar dompet** lewat perintah teks bebas.
3. **Tandai checklist transaksi berulang jadi lunas** lewat teks bebas yang menyebut nama/kategori item checklist yang jatuh tempo/terlambat.
4. **Utang/piutang lewat teks bebas** — bikin catatan baru maupun melunasi/mencicil yang sudah ada.
5. **4 Mode Terkunci** dengan trigger kata eksak — untuk aksi finansial yang butuh presisi tinggi & tidak boleh salah tebak:
   - **Mode "koreksi"** — penyesuaian saldo dompet (setara fitur "Cek" di web).
   - **Mode "limit"/"anggaran"** — kelola (lihat/edit/tambah/hapus) limit budget.
   - **Mode "tujuan"/"goals"** — kelola (lihat/edit/tambah/hapus) tujuan tabungan.
   - **Command "help"/"bantuan"/"menu"** — pusat bantuan, daftar semua trigger & cara pakai.

## 2. GOALS

- Bot WA jadi "asisten penuh" yang bisa diajak ngobrol bebas soal seluruh data keuangan, bukan cuma pencatat transaksi satu arah.
- Semua angka yang disebutkan bot dalam menjawab query **WAJIB berasal dari data asli di Supabase**, bukan dikarang/dihitung sendiri oleh Gemini secara bebas (lihat bagian 6).
- Aksi yang risiko salah-tebaknya tinggi atau berdampak langsung ke saldo/nominal (penyesuaian saldo, ubah limit, kelola tujuan) **WAJIB lewat mode terkunci dengan trigger eksak** — tidak boleh ada ambiguitas dari tebakan AI atas kalimat bebas untuk fungsi-fungsi ini.
- Aksi harian yang frekuensinya tinggi & konteksnya biasanya jelas (checklist, transfer, utang-piutang) **tetap lewat deteksi teks bebas/general** seperti semula, TIDAK dipindah ke mode — supaya tetap cepat dipakai.
- Semua aksi tulis (transfer, tandai lunas checklist, utang/piutang) tetap ikuti prinsip Fase 7: langsung dieksekusi + balas konfirmasi, bisa dikoreksi lewat reply ke bubble.
- Seluruh fitur ini **terisolasi rapi sebagai "Versi 2"**, gampang dicabut kalau bermasalah (lihat bagian 0).

## 3. NON-GOALS (TIDAK dikerjakan di fase ini)

- Mengubah/merombak cara kerja Versi 1 (Fase 7) yang sudah ada.
- Menyimpan/menampilkan data yang tidak ada representasinya di aplikasi web.
- **Perintah kaku untuk fungsi teks bebas** (checklist, transfer, utang-piutang, query, sub-perintah DI DALAM mode) — semua deteksi ini tetap **general/fleksibel**, AI menyimpulkan maksud dari sinonim & variasi kalimat, bukan mencocokkan string persis.
  - **Pengecualian yang disengaja**: trigger kata untuk MASUK ke salah satu dari 4 mode terkunci (bagian 1 poin 5) WAJIB exact match (persis, hanya besar-kecil huruf yang diabaikan). Ini bukan kontradiksi terhadap prinsip "general" di atas — ini pengecualian sengaja khusus titik masuk mode, supaya tidak ada risiko salah "nyemplung" ke mode finansial sensitif dari kalimat yang sebenarnya bukan maksud itu. Begitu SUDAH di dalam mode, semua sub-perintah kembali fleksibel/general seperti biasa.

## 4. ARSITEKTUR (perluasan dari Fase 7)

```
Pesan WA masuk
        ↓
0. Cek: apakah user sedang berada di dalam MODE TERKUNCI aktif?
   (koreksi / limit / tujuan — lihat bagian 5.5-5.8)
   → kalau YA: pesan diproses HANYA dalam konteks mode itu.
     - Trigger fungsi lain (checklist/transfer/utang/query "?"/mode lain) yang masuk
       saat mode aktif → DITOLAK dulu, tanya konfirmasi (lanjutkan proses di mode
       aktif, atau keluar & proses permintaan baru) — lihat 5.5.
     - Pesan lain diproses sebagai sub-perintah mode (fleksibel/general).
        ↓ (kalau TIDAK sedang dalam mode manapun)
1. Cek: apakah pesan ini trigger MASUK mode (exact match, case-insensitive)?
   "koreksi" | "limit" / "anggaran" | "tujuan" / "goals" | "help" / "bantuan" / "menu"
   → kalau YA: masuk mode terkait, mulai alur mode (5.5-5.9).
        ↓ (kalau BUKAN trigger mode)
2. Cek: apakah ini REPLY ke bubble sebelumnya? (context.id)
   → kalau ya: proses sebagai edit/hapus (transaksi ATAU aksi Versi 2 lain, 5.10)
        ↓ (kalau bukan reply)
3. ROUTER INTENT VERSI 2 — teks bebas, cek satu-satu SESUAI URUTAN INI:
   a. Checklist match? (5.3)
   b. Transfer? (5.2)
   c. Utang/piutang? (5.4)
   → kalau salah satu cocok: proses sesuai intent itu
        ↓ (kalau tidak ada satupun yang cocok)
4. Cek: apakah pesan mengandung tanda tanya "?" ATAU murni "cek saldo"?
   → kalau ya: proses sebagai QUERY bebas (5.1)
        ↓ (kalau tidak)
5. FALLBACK ke alur VERSI 1 (Fase 7) — proses sebagai transaksi baru seperti biasa
```

**Poin kunci**: langkah 3 (Router Intent Versi 2 teks bebas) dan langkah 0/1 (Router Mode) adalah titik yang perlu dimatikan bareng kalau Versi 2 mau di-rollback — begitu dimatikan, semua pesan otomatis lewat jalur fallback ke Versi 1 seperti sebelum Fase 8 ada.

**Catatan urutan (perubahan dari v1.0)**: limit budget SUDAH TIDAK ADA di router intent teks bebas — sepenuhnya pindah ke Mode "limit" (5.7). Urutan router intent teks bebas sekarang murni: **checklist → transfer → utang piutang**.

## 5. FEATURE REQUIREMENTS

### 5.1 Query bebas atas seluruh data aplikasi ("tanya apa saja")

- User bisa menanyakan APA SAJA yang datanya ada di aplikasi web dalam bahasa bebas — termasuk data dari dalam mode terkunci (limit, tujuan), karena query ini sifatnya read-only dan berdiri sendiri di luar mode manapun (tidak perlu "masuk" mode dulu untuk sekadar bertanya).
- **Syarat pesan dianggap query**: WAJIB mengandung tanda tanya `?`, KECUALI khusus frasa "cek saldo" (dan variasinya) yang tetap diproses tanpa `?` mengikuti perilaku Versi 1 Fase 7 (balas total dulu lalu breakdown per dompet). Semua pertanyaan data lain TANPA `?` tidak dianggap query oleh Versi 2, dan akan jatuh ke fallback Versi 1 (kemungkinan diproses sebagai transaksi baru atau tidak dikenali).
- **WAJIB 2 tahap proses** (supaya angka yang dijawab akurat, tidak dikarang):
  1. **Tahap deterministik**: sistem (kode biasa, bukan Gemini) menghitung/mengambil angka aslinya langsung dari Supabase sesuai apa yang ditanyakan.
  2. **Tahap perangkaian bahasa**: Gemini HANYA dipakai untuk merangkai angka hasil tahap 1 jadi kalimat balasan natural — Gemini TIDAK BOLEH menghitung sendiri atau mengarang angka.
- **Cakupan data yang WAJIB bisa ditanyakan**: Laporan (breakdown kategori bulanan/mingguan, tren), Budget (limit & sisa per kategori), rata-rata harian per kategori, Tujuan Tabungan (progress tiap goal), Utang Piutang (daftar per orang & gabungan), Checklist (item mana yang masih belum bayar/jatuh tempo), ringkasan total income/expense per periode.
- **Rentang waktu default**: kalau user tidak menyebut periode/bulan spesifik, default cari **bulan berjalan (bulan ini)**. Kalau user sebut rentang/bulan tertentu, ikuti itu. Kalau user minta eksplisit "semua bulan"/"semua data"/dsb, tampilkan seluruh data tanpa filter bulan.

### 5.2 Transfer antar dompet via teks bebas

*(tidak berubah dari v1.0)*

- Contoh: "transfer dari dompet utama ke dompet tabungan 500rb", "pindahin 200 ribu ke tabungan".
- Gemini mengekstrak: dompet asal, dompet tujuan (dicocokkan ke daftar dompet yang benar-benar ada), dan nominal.
- **Langsung dieksekusi** + balas konfirmasi (dompet asal, dompet tujuan, nominal, saldo akhir kedua dompet).
- **Bisa dikoreksi lewat reply** ke bubble konfirmasi transfer.
- Kalau dompet yang disebut tidak ditemukan/ambigu (match >1 dompet dengan nama mirip), bot tanya balik untuk klarifikasi, TIDAK menebak.

### 5.3 Tandai checklist lunas via teks bebas (diperjelas dari v1.0)

- **Trigger pencocokan bukan bergantung kata kerja** (seperti "bayar") — sistem mencocokkan berdasarkan **kecocokan nama/kategori/judul item checklist itu sendiri** yang disebut user, apapun kata kerja yang dipakai. Nama yang dicocokkan harus **cocok sebagai value nama** (bukan sekadar cocok tipe/kategori transaksi) — kalau kedua sisi (yang diketik user vs nama checklist) cocok, dianggap merujuk ke checklist itu.
- **Logic pencocokan & prioritas** (WAJIB, supaya tidak bentrok dengan pencatatan transaksi biasa):
  1. Cek dulu apakah ada item checklist yang cocok DAN **statusnya "jatuh tempo hari ini" atau "terlambat"** (item yang masih "akan datang" diabaikan dari pencocokan ini).
  2. **Kalau match lebih dari 1 item** (mis. dua item due hari ini dengan nama mirip, "Cicilan Motor" & "Cicilan Mobil", dan user hanya menyebut "bayar cicilan") → **WAJIB tanya klarifikasi**, TIDAK boleh asal pilih salah satu.
  3. Kalau ada TEPAT 1 yang cocok dan due/terlambat: proses sebagai **"tandai lunas"** — memakai mekanisme yang SAMA PERSIS dengan tombol "Tandai Sudah Bayar" di web (bagian 5.9 PRD utama), yang otomatis membuat transaksi sungguhan.
  4. Kalau TIDAK ada checklist yang cocok/due: pesan diproses sebagai transaksi biasa (fallback ke Versi 1), tidak dipaksakan ke checklist.
- **Sumber nominal saat tandai lunas via WA**: utamakan hasil pencocokan dari histori transaksi serupa (logic sama dengan "pengenalan nominal berulang" Fase 7) — BUKAN nilai statis di definisi checklist. Kalau histori tidak memberi nominal yang jelas/konsisten, JANGAN dipaksakan sebagai pelunasan checklist — proses sebagai transaksi baru biasa.
- **Urutan prioritas router**: checklist dicek **PALING PERTAMA**, sebelum transfer dan utang-piutang (lihat bagian 4).

### 5.4 Utang/piutang via teks bebas (diperjelas dari v1.0)

- **Deteksi**: kata kunci bermakna utang/piutang/meminjam/pinjam atau sinonim semakna, DIGABUNG dengan penyebutan nama orang. Deteksi general (AI menyimpulkan maksud), bukan pencocokan kata persis.
- **Logic nominal terhadap utang yang sudah ada** (WAJIB, ini yang menentukan apakah pesan dianggap cicilan atau utang baru):
  - Kalau orang tersebut **sudah punya catatan utang/piutang berjalan**, dan nominal yang disebut **LEBIH KECIL dari sisa utang berjalan** → dianggap **cicilan/pelunasan sebagian**, sisa utang dikurangi sebesar nominal itu.
  - Kalau nominal yang disebut **tidak punya konteks yang jelas menunjukkan itu cicilan** (mis. tidak ada utang berjalan sama sekali ke orang itu, atau nominalnya sama/lebih besar dari sisa berjalan) → dianggap **catatan utang/piutang BARU** (ditambahkan, bukan mengurangi).
  - Pelunasan (baik cicilan maupun lunas penuh) **WAJIB memengaruhi saldo dompet sungguhan**, sama seperti aturan pelunasan utang/piutang yang sudah ada di web (bagian 5.13 PRD utama).
- **Juga bisa ditanya/query** (mis. "utang aku ke siapa aja") — bagian dari kemampuan query umum 5.1.
- **Urutan prioritas router**: dicek PALING TERAKHIR dari 3 intent teks bebas (checklist → transfer → utang piutang), karena frekuensi pemakaiannya paling jarang dibanding pencatatan transaksi baru.

### 5.5 Mode Terkunci — Prinsip Umum (BARU di v2.0)

Berlaku untuk ketiga mode aksi (koreksi, limit, tujuan) dan command help di bagian 5.6–5.9:

- **Trigger masuk mode**: exact match, case-insensitive (huruf besar/kecil diabaikan, selebihnya harus persis sama). Daftar trigger:
  | Mode | Trigger (exact) |
  |---|---|
  | Bantuan | `help`, `bantuan`, `menu` |
  | Koreksi (penyesuaian saldo) | `koreksi` |
  | Limit/Anggaran | `limit`, `anggaran` |
  | Tujuan/Goals | `tujuan`, `goals` |
- **Mode-lock**: begitu masuk salah satu mode (koreksi/limit/tujuan), **semua fungsi lain terkunci total** — checklist, transfer, utang-piutang, query bebas (termasuk yang pakai `?`), dan trigger mode lain TIDAK BISA nyelonong masuk selama mode masih aktif. Kalau pesan seperti itu masuk saat mode aktif, sistem **menolak dulu** dan tanya konfirmasi: mau tetap lanjutkan proses di mode yang aktif sekarang, atau keluar dari mode (membatalkan progres yang belum dikonfirmasi) dan proses permintaan baru itu — dijawab `ya` (keluar & proses baru) / `tidak` atau `batal` (tetap di mode aktif).
- **Sub-perintah di dalam mode fleksibel/general** — begitu SUDAH di dalam mode, kata-kata seperti "edit", "tambah", "hapus" TIDAK perlu exact match, AI boleh menyimpulkan maksud dari kalimat natural, karena konteks sudah terkunci sehingga risiko ambigu dengan fungsi lain sudah hilang.
- **Kata universal semua mode**:
  - `batal` (exact) — keluar dari mode tanpa efek apapun ke data.
  - `ya` / `oke` (fleksibel) — konfirmasi untuk mengeksekusi aksi final mode.
- **Timeout**: 5 menit tanpa aktivitas apapun dalam mode → mode otomatis keluar sendiri (auto-cancel, tanpa efek ke data). Begitu user masuk mode, bot WAJIB menjelaskan singkat cara keluar (ketik `batal`) di pesan pertama mode itu.
- **Ambiguitas nama di dalam mode**: kalau referensi yang disebut user (nama dompet/kategori/goal) cocok ke **lebih dari 1 kandidat sekaligus** (mis. "GoPay Utama" dan "GoPay Bisnis" sama-sama cocok kata "gopay") → sistem **WAJIB tanya klarifikasi dulu**, tidak boleh asal pilih — prinsip yang sama dengan aturan checklist di 5.3.

### 5.6 Mode "koreksi" — Penyesuaian Saldo (BARU di v2.0, setara fitur "Cek" di web)

Fitur ini mengisi kebutuhan yang sebelumnya cuma ada di tab "Cek" pada aplikasi web (penyesuaian saldo sistem vs saldo aktual), sekaligus menghindari ambiguitas dengan "cek saldo" (5.1) yang artinya melihat isi dompet.

- **Masuk mode**: ketik `koreksi` (exact).
- **Alur**:
  1. Kalau user punya lebih dari 1 dompet, bot tanya dulu dompet mana yang mau dikoreksi (bisa lebih dari 1 dompet dalam 1 sesi — lihat langkah berikut).
  2. Bot menunggu input: foto (boleh kirim beberapa foto sekaligus, masing-masing foto uang cash fisik) dan/atau nilai teks nominal, untuk 1 atau beberapa dompet/e-wallet berbeda (mis. cash, GoPay, ShopeePay) dalam satu sesi yang sama.
  3. Kalau AI tidak berhasil mendeteksi indikasi nominal cash yang jelas dari foto maupun teks yang dikirim (dan tidak ada foto uang cash sama sekali) → bot tanya ulang nominalnya berapa, sebelum lanjut.
  4. Begitu data (minimal 1 nilai untuk 1 dompet) sudah lengkap → sistem langsung menganalisis dan membalas **1 bubble laporan** berisi: daftar item bernomor urut (per dompet/sumber), saldo sistem saat ini vs nilai aktual yang dilaporkan, selisih per item, dan saran nilai adjustment.
  5. User bisa lanjut berinteraksi dalam bubble/sesi yang sama:
     - **Tambah** item baru: mis. "tambah gopay 200rb".
     - **Replace/edit** nilai item yang sudah ada: sebut nomor urut ATAU nama dompet + nilai baru, mis. "gopay 16.300" atau "2 16.300" (pencocokan berdasarkan kecocokan value, bukan harus string identik — karena nama dompet bisa bervariasi).
     - **Hapus** salah satu item: sebut nomor urut atau nama dompet, mis. "hapus gopay" atau "hapus 2".
  6. **Selisih 0 tetap dilaporkan** dan mode TIDAK langsung keluar otomatis — supaya user masih sempat menambah data yang mungkin tertinggal.
  7. Ketik `ya`/`oke` → proses adjustment (saldo dompet-dompet terkait disesuaikan sungguhan ke nilai aktual, mekanisme sama dengan fitur "Cek" di web) → **mode otomatis keluar** (TIDAK loop tanya lagi, beda dari mode limit/tujuan) + bot kirim notifikasi nilai saldo terbaru tiap dompet yang disesuaikan.
  8. Ketik `batal` → keluar mode, tidak ada perubahan data sama sekali.

### 5.7 Mode "limit"/"anggaran" — Kelola Limit Budget (MENGGANTIKAN bagian 5.5 di v1.0)

- **Masuk mode**: ketik `limit` atau `anggaran` (exact).
- **Alur**:
  1. Begitu masuk mode, bot langsung menampilkan **daftar lengkap semua limit yang ada** beserta detail (kategori, nominal limit, terpakai, sisa).
  2. Bot tanya: mau **edit**, **tambah**, atau **hapus**?
     - **Edit**: user sebut nomor urut ATAU nama kategori + nominal baru → nominal **MENGGANTI (replace)** limit lama sepenuhnya, bukan diakumulasi.
     - **Tambah**: user sebut nama kategori baru + nominal → jadi limit baru untuk kategori itu.
     - **Hapus**: user sebut nomor urut atau nama kategori → **kategori itu dihapus dari daftar limit** (link limit-nya di web juga hilang). Transaksi historis yang sudah tercatat di kategori itu **TETAP ADA, TIDAK ikut terhapus** — hanya kaitannya ke limit yang hilang. (Catatan: limit tidak pernah bernilai 0 — "hapus" di sini berarti hapus kategorinya dari daftar limit, bukan set nominal jadi 0.)
  3. Setelah 1 aksi selesai (edit/tambah/hapus), mode **loop kembali** menanyakan "mau apa lagi?" — user bisa lanjut aksi lain dalam sesi yang sama, atau ketik `batal` untuk keluar mode.

### 5.8 Mode "tujuan"/"goals" — Kelola Tujuan Tabungan (BARU di v2.0)

Sebelumnya tujuan tabungan hanya bisa dibaca lewat query (5.1). Mode ini menambahkan kemampuan kelola (tulis) via WA, dengan pola yang identik dengan Mode "limit" (5.7):

- **Masuk mode**: ketik `tujuan` atau `goals` (exact).
- **Alur**:
  1. Begitu masuk mode, bot langsung menampilkan **daftar lengkap semua tujuan tabungan** beserta detail (nama goal, target nominal, progress terkumpul saat ini, sisa).
  2. Bot tanya: mau **edit**, **tambah**, atau **hapus**?
     - **Edit**: sebut nomor urut/nama goal + target baru (atau nilai lain yang diedit, mis. progress manual).
     - **Tambah**: sebut nama goal baru + target nominal.
     - **Hapus**: sebut nomor urut/nama goal → goal itu dihapus dari daftar (link di web ikut hilang), transaksi historis yang sudah terkait tetap ada, hanya kaitannya ke goal yang hilang.
  3. Setelah 1 aksi selesai, mode loop kembali menanyakan "mau apa lagi?", sampai user ketik `batal`.

### 5.9 Command "help"/"bantuan"/"menu" (BARU di v2.0)

- **Trigger**: `help`, `bantuan`, atau `menu` (exact, case-insensitive) — INI BUKAN mode terkunci (tidak butuh keluar dengan `batal`), cukup 1 balasan lalu selesai.
- **Balasan**: **1 pesan teks tunggal** (bukan dipecah beberapa bubble), isinya ringkas berbentuk poin-poin (bukan kalimat panjang), mencakup:
  1. Daftar trigger masuk tiap mode (koreksi/limit/tujuan) + fungsi singkatnya.
  2. Cara pakai sub-perintah di dalam tiap mode (edit/tambah/hapus, kata `batal`/`ya`/`oke`).
  3. Daftar fungsi teks bebas yang TIDAK butuh mode (checklist, transfer, utang-piutang) + contoh singkat.
  4. Cara pakai query bebas (`?`, kecuali "cek saldo").

### 5.10 Balasan & Reply-to-Edit/Delete untuk aksi teks bebas (dari v1.0, ruang lingkup disesuaikan)

- Aksi teks bebas (transfer, tandai lunas checklist, catat/lunasi utang-piutang) **WAJIB dibalas dengan 1 bubble konfirmasi**, mengikuti gaya format Fase 7 (terstruktur, berpadding per kelompok, tanpa emoji kecuali ✓, tanpa tanda kurung), dan **bisa dikoreksi lewat reply** ke bubble itu (extend `wa_message_transactions` dari Fase 7).
- **Aksi di dalam mode terkunci (koreksi/limit/tujuan) TIDAK memakai mekanisme reply-to-edit WA** — koreksi dilakukan langsung di dalam sesi mode itu sendiri (kirim ulang nilai baru/nomor + kata kunci hapus-tambah, lihat 5.5-5.8), karena konteksnya sudah terkunci ke 1 sesi aktif sehingga reply-to-bubble tidak diperlukan lagi untuk mengoreksi.

## 6. ATURAN ANTI-HALUSINASI ANGKA (berlaku di semua fitur query & mode)

- Ditegaskan ulang dari bagian 5.1: **setiap angka yang muncul di balasan bot untuk pertanyaan/query APAPUN wajib berasal dari hasil perhitungan/query nyata ke data Supabase** — bukan hasil "kira-kira" dari Gemini. Gemini berperan HANYA membungkus angka yang sudah pasti benar jadi kalimat enak dibaca.
- **Khusus mode "koreksi"**: nilai nominal cash dari foto dibaca oleh Gemini Vision (bukan angka pasti dari sistem, karena sumbernya foto fisik) — karena itu, sebelum eksekusi adjustment (`ya`/`oke`), laporan hasil analisis WAJIB ditampilkan dulu ke user untuk dikonfirmasi/dikoreksi manual (lihat 5.6 langkah 4-5), TIDAK boleh langsung dieksekusi otomatis dari hasil baca foto tanpa konfirmasi.

## 7. DATA MODEL (perubahan/tambahan)

- Tabel/mapping `wa_message_transactions` (dari Fase 7) **diperluas cakupannya** — mencakup transfer, checklist confirm, entri utang/piutang, supaya reply-to-edit/delete bisa menjangkau semua aksi teks bebas (5.10).
- **Tabel/state baru untuk mode terkunci** (nama diserahkan ke Antigravity, mis. `wa_mode_sessions`): menyimpan per user/nomor WA — mode yang sedang aktif (`koreksi` / `limit` / `tujuan` / tidak ada), item-item sementara yang sudah dikumpulkan dalam sesi (khusus mode koreksi: daftar dompet+nilai bernomor urut), timestamp aktivitas terakhir (untuk cek timeout 5 menit), dan dompet yang sedang dipilih (kalau relevan). State ini dihapus/direset begitu mode keluar (baik lewat `batal`, `ya`/`oke`, maupun timeout).
- Tidak ada tabel data transaksi baru di luar yang sudah ada dari Fase 1–7 — mode limit & tujuan murni membaca/menulis ke tabel `budgets` dan tabel savings goal yang sudah ada; mode koreksi murni menulis penyesuaian saldo ke `wallets`/`transactions` memakai mekanisme yang sama dengan fitur "Cek" di web.

## 8. ERROR HANDLING

- Kalau intent teks bebas (checklist/transfer/utang) terdeteksi tapi datanya ambigu (nama dompet/kategori/orang tidak ditemukan atau match >1) — bot **tanya balik untuk klarifikasi**, TIDAK menebak/mengeksekusi sembarangan.
- Kalau di dalam mode terkunci ada match nama >1 kandidat — bot **tanya balik untuk klarifikasi** juga (5.5), prinsip sama seperti di atas.
- Kalau di dalam mode terkunci user kirim pesan yang sama sekali tidak dikenali sebagai sub-perintah valid (bukan `batal`, bukan `ya`/`oke`, bukan format edit/tambah/hapus yang bisa disimpulkan) — bot tanya ulang maksudnya apa, TETAP DI DALAM mode (tidak keluar mode sendiri karena pesan tidak dikenali).
- Timeout mode (5 menit tanpa aktivitas) → keluar otomatis TANPA efek ke data, kirim notifikasi singkat bahwa mode dibatalkan karena tidak aktif.
- Kalau router intent Versi 2 (termasuk router mode) error/gagal total: **WAJIB fallback dengan aman ke alur Versi 1** (jangan sampai pesan jadi tidak terproses sama sekali).

## 9. TESTING REQUIREMENTS

- Uji semua jenis query di 5.1 (dengan & tanpa `?`, termasuk kasus khusus "cek saldo" tanpa `?`), pastikan angka cocok 100% dengan data asli.
- Uji transfer antar dompet: eksekusi benar, saldo ter-update benar, bisa di-reply untuk edit/hapus.
- Uji tandai lunas checklist: item due/terlambat cocok tepat 1 → tertandai lunas; item "akan datang" TIDAK ikut kepicu; **match >1 item due → wajib klarifikasi (bukan asal pilih)**; nominal ambigu dari histori → jatuh ke transaksi biasa.
- Uji utang/piutang: nominal < sisa utang berjalan → dianggap cicilan (kurangi, bukan tambah baru); nominal tanpa konteks jelas/tidak ada utang berjalan → dianggap catatan baru; query daftar utang/piutang.
- Uji **trigger masuk mode**: exact match berfungsi (`koreksi`, `Koreksi`, `KOREKSI` semua masuk mode; tapi kalimat yang mengandung kata itu di tengah — mis. "mau koreksi dong soal ini" — TIDAK memicu mode, sesuai prinsip exact match).
- Uji **mode-lock**: saat mode aktif, kirim pesan checklist/transfer/utang/query `?`/trigger mode lain → wajib ditolak dulu + tanya konfirmasi, tidak diproses langsung.
- Uji **timeout mode**: diamkan 5+ menit dalam mode aktif → mode keluar otomatis tanpa efek ke data.
- Uji mode "koreksi" end-to-end: multi-foto/multi-dompet dalam 1 sesi, tambah/replace/hapus item sebelum konfirmasi, selisih 0 tetap dilaporkan (tidak auto-keluar), `ya`/`oke` mengeksekusi adjustment + auto-keluar mode + notifikasi saldo terbaru, `batal` tidak mengubah data apapun.
- Uji mode "limit" & "tujuan" end-to-end: tampil daftar lengkap saat masuk mode, edit (replace bukan akumulasi), tambah, hapus (kategori/goal hilang dari daftar TAPI transaksi historis tetap ada), loop "mau apa lagi" berjalan sampai `batal`.
- Uji command "help": trigger exact (`help`/`bantuan`/`menu`) menampilkan 1 pesan lengkap sesuai cakupan 5.9.
- Uji ambiguitas nama match >1 di semua mode (dompet/kategori/goal) → wajib klarifikasi.
- Uji reply-to-edit/delete untuk bubble transfer/checklist/utang-piutang (bukan mode).
- **Uji skenario rollback**: matikan router Versi 2 (termasuk router mode), pastikan seluruh perilaku Versi 1 kembali normal 100%.
- Uji bahwa fitur inti Versi 1 (transaksi, cek saldo, hapus terakhir) TIDAK mengalami regresi akibat penambahan Versi 2.

## 10. PRE-FLIGHT CHECKLIST

1. Membaca & memahami penuh kode Fase 7 yang sudah berjalan (terutama router pesan masuk & mekanisme reply-to-edit/delete) sebelum menambahkan Router Intent/Mode Versi 2 di atasnya.
2. Menyepakati dengan pemilik produk cara paling sederhana untuk mengaktifkan/menonaktifkan Versi 2 (1 flag/konfigurasi) SEBELUM mulai coding.
3. Konfirmasi ke pemilik produk kalau ada istilah/kategori/nama dompet spesifik yang perlu dipastikan dulu sebelum logic pencocokan (matching) dibangun — termasuk memastikan trigger mode (`koreksi`/`limit`/`anggaran`/`tujuan`/`goals`/`help`/`bantuan`/`menu`) tidak bentrok dengan kebiasaan penulisan transaksi pemilik produk sehari-hari.

## 11. IMPLEMENTATION PHASES (usulan, direvisi)

1. **Fase 8.1 — Router Intent & Router Mode Versi 2 (kerangka)**: bangun modul terpisah untuk router intent teks bebas DAN router mode terkunci (termasuk state session & timeout 5 menit), dengan 1 flag on/off, fallback ke Versi 1 kalau tidak ada yang cocok/error. Uji dulu kerangka kosong untuk pastikan fallback berjalan sempurna.
2. **Fase 8.2 — Query Bebas**: implementasi tahap deterministik + perangkaian bahasa untuk seluruh cakupan 5.1, termasuk aturan `?` dan pengecualian "cek saldo".
3. **Fase 8.3 — Transfer Antar Dompet**: implementasi 5.2.
4. **Fase 8.4 — Checklist via WA**: implementasi 5.3, termasuk logic prioritas & klarifikasi match >1.
5. **Fase 8.5 — Utang/Piutang via WA**: implementasi 5.4, termasuk logic nominal < sisa utang = cicilan.
6. **Fase 8.6 — Mode "koreksi"**: implementasi 5.6 penuh (multi-foto/dompet, edit/tambah/hapus item, auto-exit setelah konfirmasi).
7. **Fase 8.7 — Mode "limit"**: implementasi 5.7 (tampil daftar, edit/tambah/hapus, loop).
8. **Fase 8.8 — Mode "tujuan"**: implementasi 5.8 (mirror 8.7).
9. **Fase 8.9 — Command "help"**: implementasi 5.9.
10. **Fase 8.10 — Pengujian Menyeluruh & Skenario Rollback**: jalankan semua di bagian 9, termasuk uji rollback penuh.

## 12. ACCEPTANCE CRITERIA

- [ ] Semua jenis query di 5.1 terjawab akurat (dengan aturan `?` & pengecualian "cek saldo"), angka selalu dari data asli.
- [ ] Transfer antar dompet via WA berfungsi, termasuk reply-to-edit/delete.
- [ ] Tandai lunas checklist via WA berfungsi sesuai logic prioritas, dan klarifikasi otomatis muncul saat match >1.
- [ ] Utang/piutang via WA (bikin baru, cicil/lunasi berdasarkan perbandingan nominal, query) berfungsi penuh.
- [ ] Mode "koreksi" berfungsi penuh: multi-dompet/foto, edit/tambah/hapus item, selisih 0 tetap dilaporkan, konfirmasi mengeksekusi adjustment + auto-keluar + notifikasi saldo terbaru.
- [ ] Mode "limit" & "tujuan" berfungsi penuh: tampil daftar lengkap di awal, edit (replace)/tambah/hapus (tanpa menghapus transaksi historis), loop sampai `batal`.
- [ ] Command "help" menampilkan 1 pesan lengkap sesuai cakupan 5.9.
- [ ] Semua trigger masuk mode bersifat exact match — kalimat yang sekadar mengandung kata trigger TIDAK memicu mode.
- [ ] Mode-lock berfungsi: fungsi lain ditolak + tanya konfirmasi saat mode aktif; timeout 5 menit berfungsi tanpa efek ke data.
- [ ] SEMUA aksi teks bebas (transfer, checklist, utang) bisa dikoreksi lewat reply ke bubble-nya.
- [ ] **Router Versi 2 (intent + mode) bisa dimatikan lewat 1 flag, dan begitu dimatikan, seluruh perilaku Versi 1 kembali normal tanpa cacat.**
- [ ] Tidak ada regresi sama sekali terhadap fitur Versi 1 (Fase 7) maupun fitur web (Fase 1–6).

## 13. DEFINITION OF DONE

Semua Acceptance Criteria terpenuhi, diuji fungsional sungguhan, TIDAK ADA regresi ke fitur yang sudah ada, dan **kemampuan rollback 1-flag benar-benar teruji berhasil**, bukan cuma diklaim.

## 14. RISKS

- **Konflik antar-intent teks bebas** — mitigasi lewat urutan prioritas checklist → transfer → utang piutang (bagian 4) + klarifikasi wajib saat match >1 (5.3).
- **Kompleksitas bertambah signifikan** dengan adanya state mode (session, timeout) — alasan utama kenapa bagian 0 (isolasi & rollback) jadi syarat mutlak.
- **Gemini Vision salah baca nominal dari foto uang cash** (mode koreksi) — dimitigasi dengan: laporan WAJIB ditampilkan & dikonfirmasi manual dulu sebelum eksekusi (6), dan user bisa edit/tambah/hapus item sebelum `ya`/`oke` (5.6).
- **User lupa sedang di dalam mode** (mis. lanjut chat topik lain) — dimitigasi dengan timeout 5 menit (5.5) dan penjelasan cara keluar di awal masuk mode.
- **Query yang sangat luas/ambigu** (mis. "gimana keuangan aku bulan ini?") bisa butuh effort lebih untuk diterjemahkan ke query deterministik — kalau di luar cakupan data yang ada, bot sebaiknya jujur bilang belum bisa jawab, bukan mengarang.

## 15. OPEN QUESTIONS

Seluruh open question dari v1.0 (bentuk teknis flag on/off, detail skenario checklist ambigu) sudah diselesaikan lewat diskusi 14 Agustus 2026 dan dituangkan ke bagian 5.3–5.9 di atas. Tidak ada open question tersisa dari sisi desain produk — sisanya murni keputusan teknis implementasi yang diserahkan ke Antigravity sesuai bagian 10.

## 16. ANTIGRAVITY IMPLEMENTATION INSTRUCTIONS (tambahan khusus fase ini)

Selain instruksi umum di PRD utama & PRD WA Fase 7:

1. **Bagian 0 (isolasi & rollback) adalah instruksi PALING WAJIB di dokumen ini** — jangan mulai coding fitur apapun di bagian 5 sebelum kerangka Router Intent + Router Mode Versi 2 (dengan flag on/off yang benar-benar berfungsi) selesai dan teruji.
2. **JANGAN PERNAH biarkan Gemini menghitung/mengarang angka finansial** — semua angka wajib dari query Supabase asli (bagian 6). Khusus mode koreksi, hasil baca Gemini Vision dari foto SELALU dianggap draft yang wajib dikonfirmasi user, bukan angka final otomatis.
3. **Trigger masuk mode WAJIB exact match sungguhan** (bukan "contains"/mengandung kata) — implementasikan sebagai perbandingan string persis (setelah normalisasi huruf besar/kecil dan trim spasi saja, tanpa fuzzy matching apapun). Ini beda dengan seluruh matching lain di dokumen ini yang sifatnya general/fleksibel.
4. Prioritaskan keamanan data — kalau ragu antara "eksekusi otomatis" vs "tanya klarifikasi dulu" untuk aksi manapun (baik teks bebas maupun di dalam mode), PILIH tanya klarifikasi.
5. Kalau pemilik produk minta "hapus Versi 2" di kemudian hari, itu artinya matikan/cabut seluruh Router Versi 2 (intent teks bebas + 4 mode) SAJA — konfirmasi dulu scope-nya ke pemilik produk sebelum eksekusi, jangan asumsi berarti hapus juga fitur Fase 7 (Versi 1).
