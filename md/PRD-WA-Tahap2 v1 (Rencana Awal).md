# PRD — Catatan Keuangan: WA Peningkatan Tahap 2 ("Versi 2")
**Fase 8 — Dokumen kerja untuk Antigravity IDE**
Versi: 1.0 · Dibuat: 13 Agustus 2026

*Dokumen ini adalah lanjutan/addendum dari `PRD-Catatan-Keuangan.md` (Fase 1–6) dan `PRD-WhatsApp-Integration.md` (Fase 7, integrasi WA dasar: catat transaksi via teks/foto/VN, cek saldo, hapus transaksi terakhir, reply-to-edit/delete). Fase ini menambahkan kemampuan baru di atas fondasi Fase 7 yang sudah berjalan baik — TANPA mengubah cara kerja fondasi itu.*

---

## 0. PRINSIP UTAMA: INI ADALAH "VERSI 2" YANG WAJIB BISA DI-ROLLBACK

Ini instruksi paling penting di seluruh dokumen ini, WAJIB dipahami dan diikuti Antigravity sebelum menulis kode apa pun:

- Semua fitur di PRD ini (mulai bagian 5 dan seterusnya) disebut **"Versi 2"**.
- Fitur inti dari Fase 7 (catat transaksi via teks/foto/VN, cek saldo, hapus transaksi terakhir, reply-to-edit/delete untuk transaksi) disebut **"Versi 1" / fondasi**, dan **TIDAK BOLEH diubah/disentuh strukturnya** untuk mengakomodasi Versi 2.
- **Versi 2 WAJIB dibangun sebagai lapisan/modul TERPISAH yang jelas** dari kode Versi 1 — bukan disisipkan tercampur ke dalam logic Versi 1. Semua kode Versi 2 (fungsi baru, prompt tambahan, routing tambahan) harus **ditandai jelas** (mis. nama file/fungsi berawalan `v2` atau komentar eksplisit `// VERSI 2` di setiap bagian terkait).
- **Tujuan penandaan ini**: kalau di kemudian hari logic Versi 2 ternyata berantakan/tidak sesuai harapan, pemilik produk cukup bilang **"hapus Versi 2"**, dan Antigravity harus bisa **mencabut/menonaktifkan seluruh modul Versi 2 itu SAJA**, sehingga aplikasi otomatis kembali ke perilaku Versi 1 (fondasi Fase 7) yang sudah terbukti jalan baik — tanpa perlu bongkar ulang fondasi.
- Cara teknis yang disarankan (Antigravity boleh menyesuaikan implementasinya, prinsip ini yang wajib dipegang): pesan masuk dari WA dicek dulu lewat **router intent Versi 2** (modul terpisah) — kalau tidak ada satupun intent Versi 2 yang cocok, baru diteruskan ke alur Versi 1 seperti biasa (fallback). Router Versi 2 ini idealnya bisa dimatikan lewat 1 flag/konfigurasi tunggal, bukan dengan menghapus banyak potongan kode tersebar.

## 1. OVERVIEW

Menambahkan kemampuan baru ke bot WhatsApp Catatan Keuangan:
1. **Query bebas (baca) atas SEMUA data/laporan yang ada di aplikasi web** — sisa anggaran, kategori apa saja yang ada, pengeluaran terbesar bulan ini, total pemasukan/pengeluaran per periode (harian/mingguan/bulanan), rata-rata harian per kategori, progress tujuan tabungan, daftar utang/piutang, dsb. **Prinsip: kalau di web ada fiturnya, di WA pasti bisa ditanyakan, tanpa terkecuali.**
2. **Transfer antar dompet** lewat perintah teks bebas (mis. "transfer dari dompet utama ke dompet tabungan 500rb").
3. **Tandai checklist transaksi berulang jadi lunas** lewat teks bebas yang menyebut nama/kategori item checklist yang sudah jatuh tempo/terlambat (mis. "bayar kuliah", "bayar cicilan motor").
4. **Utang/piutang lewat teks bebas** — bikin catatan baru maupun melunasi yang sudah ada, dideteksi dari kata kunci terkait (utang/piutang/pinjam/meminjam/dsb) + nama orang.
5. **Ubah limit budget** lewat teks bebas yang menyebut kata kunci terkait (limit/anggaran/budget/dsb) + kategori + nominal.

## 2. GOALS

- Bot WA jadi "asisten penuh" yang bisa diajak ngobrol bebas soal seluruh data keuangan, bukan cuma pencatat transaksi satu arah.
- Semua angka yang disebutkan bot dalam menjawab query **WAJIB berasal dari data asli di Supabase**, bukan dikarang/dihitung sendiri oleh Gemini secara bebas (lihat bagian 6).
- Semua aksi tulis baru (transfer, tandai lunas checklist, utang/piutang, ubah limit) tetap ikuti prinsip yang sudah mapan dari Fase 7: langsung dieksekusi + balas konfirmasi, dan **bisa dikoreksi lewat reply ke bubble balasannya** (extend mekanisme reply-to-edit/delete yang sudah ada).
- Seluruh fitur ini **terisolasi rapi sebagai "Versi 2"**, gampang dicabut kalau bermasalah (lihat bagian 0).

## 3. NON-GOALS (TIDAK dikerjakan di fase ini)

- Mengubah/merombak cara kerja Versi 1 (Fase 7) yang sudah ada — transaksi, cek saldo, hapus transaksi terakhir tetap seperti sekarang.
- Perintah/format kaku yang harus diketik user persis kata-per-kata — semua deteksi kata kunci di fase ini bersifat **general/fleksibel**, AI yang menyimpulkan maksud dari sinonim & variasi kalimat, BUKAN mencocokkan string persis.
- Menyimpan/menampilkan data yang tidak ada representasinya di aplikasi web — kalau suatu data tidak ada di web, tidak perlu dipaksakan bisa ditanya di WA juga.

## 4. ARSITEKTUR (perluasan dari Fase 7)

```
Pesan WA masuk
        ↓
1. Cek dulu: apakah ini REPLY ke bubble sebelumnya? (context.id)
   → kalau ya: proses sebagai edit/hapus (transaksi ATAU aksi Versi 2 lain, lihat bagian 5.6)
        ↓ (kalau bukan reply)
2. ROUTER INTENT VERSI 2 (modul terpisah, lihat bagian 0)
   → cek satu-satu: checklist match? transfer? utang/piutang? ubah limit? query/pertanyaan data?
   → kalau salah satu cocok: proses sesuai intent itu (bagian 5)
        ↓ (kalau tidak ada satupun yang cocok)
3. FALLBACK ke alur VERSI 1 (Fase 7) — proses sebagai transaksi baru/query saldo/dsb seperti biasa
```

**Poin kunci**: langkah 2 (Router Intent Versi 2) adalah SATU-SATUNYA titik yang perlu dimatikan kalau Versi 2 mau di-rollback — begitu dimatikan, semua pesan otomatis lewat jalur fallback ke Versi 1 seperti sebelum Fase 8 ada.

## 5. FEATURE REQUIREMENTS

### 5.1 Query bebas atas seluruh data aplikasi ("tanya apa saja")

- User bisa menanyakan APA SAJA yang datanya ada di aplikasi web dalam bahasa bebas, contoh: "sisa anggaran makan berapa", "anggaran apa aja yang aku punya", "pengeluaran terbesar bulan ini apa", "pemasukan minggu ini berapa", "rata-rata pengeluaran harian kategori jajan berapa", "progress nabung laptop udah berapa persen", "siapa aja yang masih punya utang ke aku".
- **WAJIB 2 tahap proses** (supaya angka yang dijawab akurat, tidak dikarang):
  1. **Tahap deterministik**: sistem (kode biasa, bukan Gemini) menghitung/mengambil angka aslinya langsung dari Supabase sesuai apa yang ditanyakan (mis. total pengeluaran kategori "Makan" bulan berjalan, sisa limit budget, dsb).
  2. **Tahap perangkaian bahasa**: Gemini HANYA dipakai untuk merangkai angka hasil tahap 1 itu jadi kalimat balasan yang natural — Gemini TIDAK BOLEH menghitung sendiri atau mengarang angka yang tidak berasal dari hasil query tahap 1.
- **Cakupan data yang WAJIB bisa ditanyakan** (mengikuti prinsip "kalau ada di web, pasti bisa di WA"): Laporan (breakdown kategori bulanan/mingguan, tren), Budget (limit & sisa per kategori), rata-rata harian per kategori (fitur dashboard yang sudah ada), Tujuan Tabungan (progress tiap goal), Utang Piutang (daftar per orang & gabungan), Checklist (item mana yang masih belum bayar/jatuh tempo), ringkasan total income/expense per periode (hari/minggu/bulan, bebas rentang wajar).

### 5.2 Transfer antar dompet via teks bebas

- Contoh: "transfer dari dompet utama ke dompet tabungan 500rb", "pindahin 200 ribu ke tabungan".
- Gemini mengekstrak: dompet asal, dompet tujuan (dicocokkan ke daftar dompet yang benar-benar ada), dan nominal.
- **Langsung dieksekusi** (kurangi saldo dompet asal, tambah saldo dompet tujuan, pakai mekanisme transfer yang sudah ada di aplikasi) + balas konfirmasi (format serupa bagian 5.6 PRD WA Fase 7, disesuaikan untuk transfer: dompet asal, dompet tujuan, nominal, saldo akhir kedua dompet).
- **Bisa dikoreksi lewat reply** ke bubble konfirmasi transfer itu (edit nominal/dompet, atau hapus/batalkan transfer) — extend mapping `wa_message_transactions` dari Fase 7 supaya juga mencakup transfer.
- Kalau dompet yang disebut tidak ditemukan/ambigu, bot tanya balik untuk klarifikasi, TIDAK menebak.

### 5.3 Tandai checklist lunas via teks bebas

- Contoh: user ketik "bayar kuliah", "bayar cicilan motor" — dicocokkan ke item checklist yang namanya/kategorinya mirip.
- **Logic pencocokan & prioritas** (WAJIB, supaya tidak bentrok dengan pencatatan transaksi biasa):
  1. Cek dulu apakah ada item checklist yang cocok DAN **statusnya "jatuh tempo hari ini" atau "terlambat"** (BUKAN yang masih "akan datang" — item yang belum jatuh tempo diabaikan dari pencocokan ini).
  2. Kalau ada yang cocok dan due/terlambat: proses sebagai **"tandai lunas"** — ini memakai mekanisme yang SAMA PERSIS dengan tombol "Tandai Sudah Bayar" yang sudah ada di web (bagian 5.9 PRD utama), yang otomatis membuat transaksi sungguhan sebagai bagian dari proses konfirmasi tsb. Ini BUKAN "checklist vs transaksi" yang terpisah — menandai lunas MEMANG cara checklist menghasilkan transaksi, sama seperti di web.
  3. Kalau TIDAK ada checklist yang cocok/due: pesan diproses sebagai transaksi biasa (fallback ke Versi 1), tidak dipaksakan ke checklist.
- **Sumber nominal saat tandai lunas via WA**: **utamakan hasil pencocokan dari histori transaksi serupa** (logic yang sama dengan "pengenalan nominal berulang" di bagian 5.1 PRD WA Fase 7) — BUKAN nilai statis yang tersimpan di definisi checklist. Kalau histori transaksi tidak memberikan nominal yang jelas/konsisten, JANGAN dipaksakan sebagai pelunasan checklist — proses sebagai transaksi baru biasa saja (bukan menandai checklist lunas dengan angka yang tidak yakin).
  - *(Catatan untuk Antigravity: perilaku ini agak nuanced — kalau ambigu saat implementasi/pengujian, prioritaskan supaya TIDAK PERNAH menandai checklist lunas dengan nominal yang meragukan; lebih aman jatuhkan ke transaksi biasa lalu biarkan pemilik produk mengoreksi manual kalau perlu.)*

### 5.4 Utang/piutang via teks bebas

- **Deteksi**: kata kunci yang bermakna utang/piutang/meminjam/pinjam atau sinonim yang semakna, DIGABUNG dengan penyebutan nama orang. Deteksi ini general (AI yang menyimpulkan maksud), bukan pencocokan kata persis.
- **Mencakup 2 aksi**:
  1. **Bikin catatan baru** (mis. "pinjam ke Budi 100rb", "Sari utang ke aku 50rb").
  2. **Melunasi yang sudah ada** (mis. "bayar utang ke Budi 100rb") — ini WAJIB memengaruhi saldo dompet sungguhan, sama seperti aturan pelunasan utang/piutang yang sudah ada di web (bagian 5.13 PRD utama).
- **Juga bisa ditanya/query** (mis. "utang aku ke siapa aja", "siapa yang masih punya utang ke aku") — ini bagian dari kemampuan query umum di bagian 5.1, memakai data Utang Piutang yang sudah ada.

### 5.5 Ubah limit budget via teks bebas

- **Deteksi**: kata kunci bermakna limit/anggaran/budget atau sinonim yang semakna, DIGABUNG dengan nama kategori dan nominal. General/fleksibel, bukan format kaku.
- **Perilaku**: nominal yang disebut **MENGGANTI (replace) limit lama** kategori itu sepenuhnya menjadi nominal baru — BUKAN ditambahkan/diakumulasi ke limit sebelumnya. Kalau kategori yang disebut belum punya limit sebelumnya, ini otomatis jadi limit baru untuk kategori itu.
- Balas konfirmasi berisi kategori, limit lama (kalau ada), dan limit baru yang berlaku.

### 5.6 Balasan & Reply-to-Edit/Delete untuk semua aksi Versi 2

- Semua aksi tulis Versi 2 (transfer, tandai lunas checklist, catat/lunasi utang-piutang, ubah limit budget) **WAJIB dibalas dengan 1 bubble konfirmasi**, mengikuti gaya format yang sudah mapan di Fase 7 (bagian 5.6 PRD WA — terstruktur, berpadding per kelompok, tanpa emoji kecuali ✓, tanpa tanda kurung).
- Message ID tiap bubble ini **WAJIB dipetakan** (extend tabel `wa_message_transactions` dari Fase 7, atau tabel mapping serupa) ke aksi/data terkait — supaya **reply ke bubble manapun (baik transaksi biasa, transfer, checklist, utang-piutang, maupun limit budget) bisa dipakai untuk edit/hapus aksi itu**, konsisten dengan mekanisme reply-to-edit/delete yang sudah ada (bagian 5.7 PRD WA Fase 7).

## 6. ATURAN ANTI-HALUSINASI ANGKA (penting, berlaku di semua fitur query)

Ditegaskan ulang dari bagian 5.1: **setiap angka yang muncul di balasan bot untuk pertanyaan/query APAPUN wajib berasal dari hasil perhitungan/query nyata ke data Supabase** — bukan hasil "kira-kira" dari Gemini. Gemini di fitur query ini perannya HANYA membungkus angka yang sudah pasti benar jadi kalimat enak dibaca, sama sekali tidak diberi kewenangan menghitung sendiri dari ingatan/asumsi.

## 7. DATA MODEL (perubahan/tambahan)

- Tabel/mapping `wa_message_transactions` (dari Fase 7) **diperluas cakupannya** — tidak cuma untuk transaksi, tapi juga transfer, checklist confirm, entri utang/piutang, dan perubahan limit budget, supaya reply-to-edit/delete bisa menjangkau semua aksi Versi 2.
- Tidak ada tabel data baru di luar yang sudah ada dari Fase 1–7 — semua fitur di PRD ini murni membaca/menulis ke tabel yang sudah ada (`transactions`, `wallets`, `categories`, `budgets`, savings goal, debt entries, recurring items).

## 8. ERROR HANDLING

- Kalau intent Versi 2 terdeteksi tapi datanya ambigu (mis. nama dompet/kategori/orang tidak ditemukan atau ada beberapa kemungkinan cocok) — bot **tanya balik untuk klarifikasi**, TIDAK menebak/mengeksekusi sembarangan.
- Kalau router intent Versi 2 error/gagal total: **WAJIB fallback dengan aman ke alur Versi 1** (jangan sampai pesan jadi tidak terproses sama sekali — selaras dengan prinsip "tidak boleh ada pesan menggantung" dari daftar perbaikan Fase 7).

## 9. TESTING REQUIREMENTS

- Uji semua jenis query di bagian 5.1, pastikan angka yang dijawab cocok 100% dengan data asli (bandingkan manual ke web).
- Uji transfer antar dompet: eksekusi benar, saldo kedua dompet ter-update benar, bisa di-reply untuk edit/hapus.
- Uji tandai lunas checklist: item due/terlambat cocok → tertandai lunas + transaksi tercatat; item "akan datang" TIDAK ikut kepicu; nominal ambigu → jatuh ke transaksi biasa (bukan checklist).
- Uji utang/piutang: bikin baru, lunasi yang sudah ada (saldo dompet berubah benar), dan query daftar utang/piutang.
- Uji ubah limit budget: replace nominal (bukan akumulasi), untuk kategori yang sudah ada limit maupun belum.
- Uji reply-to-edit/delete untuk SEMUA jenis bubble baru (transfer, checklist, utang-piutang, limit budget), bukan cuma transaksi.
- **Uji skenario rollback**: matikan router intent Versi 2, pastikan seluruh perilaku Versi 1 (Fase 7) kembali normal 100% seperti sebelum Fase 8 dikerjakan.
- Uji bahwa fitur inti Versi 1 (transaksi, cek saldo, hapus terakhir) TIDAK mengalami regresi sama sekali akibat penambahan Versi 2.

## 10. PRE-FLIGHT CHECKLIST

Sama seperti prinsip PRD sebelumnya — sebelum mulai, Antigravity WAJIB:
1. Membaca & memahami penuh kode Fase 7 yang sudah berjalan (terutama router pesan masuk & mekanisme reply-to-edit/delete) sebelum menambahkan Router Intent Versi 2 di atasnya.
2. Menyepakati dengan pemilik produk cara paling sederhana untuk mengaktifkan/menonaktifkan Versi 2 (1 flag/konfigurasi) SEBELUM mulai coding — bagian 0 adalah syarat mutlak, bukan nice-to-have.
3. Konfirmasi ke pemilik produk kalau ada istilah/kategori/nama dompet spesifik yang perlu dipastikan dulu sebelum logic pencocokan (matching) dibangun.

## 11. IMPLEMENTATION PHASES (usulan)

1. **Fase 8.1 — Router Intent Versi 2 (kerangka)**: bangun modul terpisah untuk router intent, dengan 1 flag on/off, dan fallback ke Versi 1 kalau tidak ada intent cocok atau router error. Uji dulu kerangka ini kosong (belum ada intent apapun) untuk pastikan fallback berjalan sempurna.
2. **Fase 8.2 — Query Bebas**: implementasi tahap deterministik (ambil data asli) + tahap perangkaian bahasa (Gemini) untuk seluruh cakupan di bagian 5.1.
3. **Fase 8.3 — Transfer Antar Dompet**: implementasi bagian 5.2, termasuk reply-to-edit/delete untuk transfer.
4. **Fase 8.4 — Checklist via WA**: implementasi bagian 5.3, termasuk logic prioritas & fallback nominal ambigu.
5. **Fase 8.5 — Utang/Piutang via WA**: implementasi bagian 5.4 (bikin baru + lunasi + query).
6. **Fase 8.6 — Limit Budget via WA**: implementasi bagian 5.5.
7. **Fase 8.7 — Pengujian Menyeluruh & Skenario Rollback**: jalankan semua di bagian 9, termasuk uji rollback penuh.

## 12. ACCEPTANCE CRITERIA

- [ ] Semua jenis query di bagian 5.1 terjawab akurat, angka selalu berasal dari data asli (bukan karangan Gemini).
- [ ] Transfer antar dompet via WA berfungsi, termasuk reply-to-edit/delete.
- [ ] Tandai lunas checklist via WA berfungsi sesuai logic prioritas & fallback nominal di bagian 5.3.
- [ ] Utang/piutang via WA (bikin baru, lunasi, query) berfungsi penuh.
- [ ] Ubah limit budget via WA berfungsi (replace, bukan akumulasi).
- [ ] SEMUA aksi Versi 2 bisa dikoreksi lewat reply ke bubble-nya.
- [ ] **Router Intent Versi 2 bisa dimatikan lewat 1 flag, dan begitu dimatikan, seluruh perilaku Versi 1 kembali normal tanpa cacat.**
- [ ] Tidak ada regresi sama sekali terhadap fitur Versi 1 (Fase 7) maupun fitur web (Fase 1–6).

## 13. DEFINITION OF DONE

Sama seperti PRD sebelumnya — semua Acceptance Criteria terpenuhi, diuji fungsional sungguhan, TIDAK ADA regresi ke fitur yang sudah ada, dan **kemampuan rollback 1-flag benar-benar teruji berhasil**, bukan cuma diklaim.

## 14. RISKS

- **Konflik antar-intent** — pesan yang ambigu bisa berpotensi cocok ke lebih dari 1 intent Versi 2 sekaligus (mis. "bayar kuliah" bisa dibaca sebagai checklist ATAU transaksi baru biasa) — mitigasi lewat urutan prioritas yang jelas di bagian 4 & 5.3.
- **Kompleksitas bertambah signifikan** — ini alasan utama kenapa bagian 0 (isolasi & rollback) jadi syarat mutlak, bukan sekadar saran.
- **Query yang sangat luas/ambigu** (mis. "gimana keuangan aku bulan ini") bisa butuh effort lebih untuk diterjemahkan ke query deterministik yang tepat — kalau ada pertanyaan yang benar-benar di luar cakupan data yang ada, bot sebaiknya jujur bilang belum bisa jawab itu, bukan mengarang.

## 15. OPEN QUESTIONS

- Detail teknis "flag on/off" untuk Router Intent Versi 2 — bentuknya seperti apa (env var, kolom di Settings, dsb) diserahkan ke Antigravity untuk diusulkan & disepakati di awal Fase 8.1 (lihat bagian 10).
- Skenario checklist dengan nominal ambigu (bagian 5.3) — perilaku persis saat pengujian nyata mungkin perlu disesuaikan bersama pemilik produk.

## 16. ANTIGRAVITY IMPLEMENTATION INSTRUCTIONS (tambahan khusus fase ini)

Selain instruksi umum di PRD utama & PRD WA Fase 7:
1. **Bagian 0 (isolasi & rollback) adalah instruksi PALING WAJIB di dokumen ini** — jangan mulai coding fitur apapun di bagian 5 sebelum kerangka Router Intent Versi 2 (dengan flag on/off yang benar-benar berfungsi) selesai dan teruji.
2. **JANGAN PERNAH biarkan Gemini menghitung/mengarang angka finansial** — semua angka wajib dari query Supabase asli (bagian 6).
3. Prioritaskan keamanan data — kalau ragu antara "eksekusi otomatis" vs "tanya klarifikasi dulu" untuk aksi Versi 2 manapun, PILIH tanya klarifikasi (lebih aman daripada salah eksekusi transfer/hapus/ubah limit).
4. Kalau pemilik produk minta "hapus Versi 2" di kemudian hari, itu artinya matikan/cabut Router Intent Versi 2 SAJA — konfirmasi dulu scope-nya ke pemilik produk sebelum eksekusi, jangan asumsi itu berarti hapus juga fitur Fase 7 (Versi 1).
