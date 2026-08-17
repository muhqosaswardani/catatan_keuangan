# Bug Report & PRD Perbaikan — WA Bot & Web (Cross-check Saldo)
**Aplikasi:** Catatan Keuangan
**Tanggal:** 15 Agustus 2026

---

## 1. Daftar Bug

### A. WA Bot

| # | Area | Judul Bug | Deskripsi |
|---|------|-----------|-----------|
| 1 | Query Data | Data yang dibaca AI tidak akurat/tidak update | Pertanyaan seperti "transaksi hari ini ada apa aja?" atau "makan hari ini keluar berapa?" kadang hanya mengembalikan sebagian transaksi, atau bahkan bilang data "tidak tercatat", padahal transaksi tersebut jelas ada di web (contoh nyata: transaksi kategori Makan tidak terbaca meski ada di sistem). Data yang dibaca AI tidak sinkron/akurat dengan database. |
| 2 | Cek Saldo | Balasan "cek saldo" berubah jadi narasi AI bebas | Balasan seharusnya selalu memakai template baku (breakdown saldo per dompet, urut ke bawah), tapi kadang dijawab dengan kalimat naratif general ala AI biasa, bukan format template yang konsisten. |
| 3 | Parsing Transaksi | Salah penentuan dompet pada transaksi | AI tidak membaca nama dompet dari struk/teks (misal "Livin" seharusnya cocok ke dompet "Livin"), dan ketika tidak ada indikasi dompet, transaksi tidak jatuh ke dompet primary sesuai setting web. Contoh nyata: transaksi token listrik masuk ke dompet "e-Wallet" padahal itu bukan dompet primary. |
| 4 | Deteksi Mode Query | Deteksi pertanyaan hanya berdasarkan simbol "?" | Sistem saat ini hanya menganggap sebuah pesan sebagai "pertanyaan" (mode query/preview) jika mengandung tanda tanya "?" secara eksplisit. Pesan dengan maksud sama tapi tanpa "?" tidak terdeteksi sebagai query, sehingga jawabannya tidak konsisten (kadang detail benar, kadang bilang "belum ada transaksi"). |
| 7 | Utang/Piutang | Fitur utang-piutang gagal saat trigger eksplisit | Pesan "pinjem uang ke ibu 200rb" (mengandung kata kunci eksplisit "pinjem") gagal dengan error "kesalahan internal", seharusnya membuat entri utang-piutang. *(Catatan: kalimat tanpa kata kunci eksplisit seperti "dpet uang dari ibu 200rb" yang masuk ke Pemasukan kategori "Lainnya" sudah benar dan bukan bug.)* |
| 8 | Parsing Transaksi & Sinkronisasi | Transaksi tanpa dompet spesifik salah masuk dompet + tidak sync ke web | Kasus baru mirip Bug #3: transaksi Pemasukan dari foto struk transfer (tanpa menyebut dompet spesifik) malah masuk ke "Dompet Tabungan", padahal seharusnya jatuh ke dompet primary (Dompet Utama). Ditemukan juga bug sinkronisasi: transaksi yang tercatat ke Dompet Tabungan **tidak muncul sama sekali** di laporan web, dan baru sync setelah user mengoreksi dompetnya ke Dompet Utama via WA. |

### B. Web — Fitur Cross-check Saldo (Rekonsiliasi)

| # | Area | Judul Bug | Deskripsi |
|---|------|-----------|-----------|
| 5 | Scope Rekonsiliasi | Dompet yang tidak dicentang tetap ikut dianalisis | Saat hanya "Dompet Utama" yang dicentang di "Pilih Cakupan Dompet", hasil "Analisa dengan AI" tetap menampilkan & menghitung "Dompet Tabungan" yang tidak dicentang. Scope filter tidak dihormati. |
| 6 | Input Saldo Terbaca | Input hanya bisa lewat media/foto | Pada kartu "Hasil Analisis AI" per dompet, field "Saldo Terbaca" saat ini hanya bisa diisi lewat upload foto/media. Tidak ada opsi input teks langsung (misal ketik "cash" atau ketik nominal) untuk dompet yang tidak punya bukti foto, sehingga user terpaksa keluar ke "+ Tambah Manual" secara terpisah. |
| 9 | Insight AI (Beranda) | Auto-update terjadwal membaca data sebagai kosong | Fitur "Ringkasan otomatis dari AI" di Beranda auto-update tiap tengah malam jam 00.00. Saat proses auto-update sistem berjalan, AI membaca data seolah kosong (bilang saldo Rp0, belum ada aktivitas) padahal transaksi sudah ada. Saat user refresh manual, AI membaca data dengan benar. Bug hanya terjadi pada proses otomatis jam 00.00. |

---

## 2. PRD Perbaikan

### Bug #1 — Akurasi Pembacaan Data pada Query WA
**Masalah:** Query transaksi kadang menangkap sebagian data atau bahkan salah bilang "tidak tercatat", padahal data jelas ada di database (contoh nyata: transaksi kategori Makan tidak terbaca meski ada di sistem).

**Perbaikan yang diminta:**
- Setiap query data (transaksi, saldo, laporan, dsb) di WA wajib mengambil data yang benar-benar sesuai dengan kondisi database saat ini — tidak boleh ada data yang terlewat atau salah dilaporkan "tidak ada".
- Query wajib mengambil **seluruh** data yang match dengan filter pertanyaan (tanggal/kategori/dompet apa pun), bukan hanya sebagian.

**Acceptance Criteria:**
- Semua transaksi yang match dengan pertanyaan (tanggal/kategori/dompet apa pun) selalu ikut terbaca & dijawab dengan benar, tidak ada lagi kasus "data tidak tercatat" padahal ada.

---

### Bug #2 — Template Baku untuk Cek Saldo
**Masalah:** Balasan "cek saldo" kadang dijawab AI secara naratif bebas, bukan format template konsisten.
**Perbaikan yang diminta:**
- "cek saldo" (tanpa "?", sesuai desain existing) selalu dijawab dengan template tetap: breakdown saldo per dompet (urut sesuai `order`, primary di atas), diikuti Total Saldo di baris paling bawah.
- AI tidak diberi kebebasan merangkai kalimat untuk respons ini — hanya isi angka yang dinamis, format & susunan kalimat tetap (template-driven, bukan generative untuk bagian ini).

**Acceptance Criteria:**
- Setiap kali user kirim "cek saldo", format balasan selalu identik strukturnya, hanya nominal yang berubah sesuai data terbaru.

---

### Bug #3 — Deteksi Dompet pada Parsing Transaksi
**Masalah:** AI tidak mencocokkan nama dompet dari konteks (foto/teks), dan fallback ke primary dompet tidak berjalan benar — transaksi malah nyasar ke dompet yang salah (bukan primary).
**Perbaikan yang diminta:**
1. Saat parsing transaksi (dari foto struk atau teks), AI wajib mencoba mencocokkan nama dompet dari isi struk/teks terhadap daftar nama dompet yang ada di sistem (fuzzy match, tidak harus persis sama — konsisten dengan aturar matching dompet di fitur lain).
2. Jika ada match jelas → transaksi masuk ke dompet tersebut.
3. Jika tidak ada indikasi dompet sama sekali → transaksi **wajib** masuk ke dompet yang ditandai `isPrimary` di web (bukan dompet lain seperti "e-Wallet").
4. Perbaiki bug spesifik: pastikan logic penentuan dompet primary benar-benar mengambil dari field/flag primary di database, bukan hardcode atau default nama tertentu.

**Acceptance Criteria:**
- Transaksi dengan nama dompet yang jelas di struk masuk ke dompet yang sesuai.
- Transaksi tanpa indikasi dompet sama sekali masuk ke dompet primary sesuai setting web, teruji dengan kasus token listrik yang sebelumnya salah masuk ke "e-Wallet".

---

### Bug #4 — Perluasan Deteksi Mode Query
**Masalah:** Deteksi "ini pertanyaan/query" hanya berdasarkan keberadaan simbol "?", sehingga kalimat tanya tanpa "?" gagal terdeteksi dan dijawab asal/general.
**Perbaikan yang diminta:**
- Ganti logic deteksi dari rule "harus ada karakter ?" menjadi klasifikasi intent oleh AI sendiri: AI menentukan apakah sebuah pesan masuk kategori **transaksi baru**, **query/pertanyaan data**, atau **obrolan umum di luar konteks** — berdasarkan makna kalimat, bukan simbol.
- Untuk pesan yang diklasifikasikan sebagai obrolan umum di luar konteks transaksi, balasan tetap natural (gaya bebas AI), **namun tetap "natural by data konteks"** — AI tetap harus punya akses dan merujuk ke data asli yang relevan jika dibutuhkan, bukan menjawab natural tanpa pijakan data sama sekali.
- Aturan existing lain (mode terkunci: koreksi/limit/tujuan/help; "cek saldo" tanpa wajib "?") tetap dipertahankan sebagai pengecualian khusus.

**Acceptance Criteria:**
- Pertanyaan tanpa tanda tanya eksplisit (misal "transaksi hari ini ada apa aja") tetap terdeteksi sebagai query dan dijawab dengan data lengkap & konsisten, tidak lagi bergantung ke ada/tidaknya karakter "?".

---

### Bug #7 — Fitur Utang/Piutang Gagal Saat Trigger Eksplisit
**Masalah:** Kalimat dengan kata kunci eksplisit terkait utang-piutang (misal "pinjem uang ke ibu 200rb" — mengandung kata "pinjem") gagal diproses dengan error "kesalahan internal", padahal seharusnya membuat entri di fitur utang-piutang yang sudah ada di web.

**Definisi trigger yang disepakati:** fitur utang-piutang hanya dipanggil kalau ada kata kunci eksplisit — "utang", "piutang", "pinjem", atau beberapa frasa spesifik lain yang jelas menandakan maksud utang/piutang. Kalimat tanpa kata kunci eksplisit (misal "dpet uang dari ibu 200rb") boleh tetap dicatat sebagai transaksi Pemasukan/Pengeluaran biasa — itu bukan bug.

**Perbaikan yang diminta:**
- Investigasi & perbaiki penyebab error "kesalahan internal" saat kalimat mengandung kata kunci eksplisit utang-piutang seperti "pinjem".
- Pastikan kalimat dengan kata kunci eksplisit tersebut berhasil diarahkan ke logic utang-piutang (sesuai desain Fase 8 — buat entri baru atau lunasi via teks).

**Acceptance Criteria:**
- Kalimat dengan kata kunci eksplisit ("utang", "piutang", "pinjem", dsb) berhasil membuat entri utang/piutang tanpa error internal.
- Kalimat tanpa kata kunci eksplisit tetap masuk sebagai transaksi Pemasukan/Pengeluaran biasa seperti sekarang (perilaku ini dipertahankan, tidak diubah).

---

### Bug #8 — Salah Dompet Primary & Data Tidak Sync ke Web
**Masalah:** Ini adalah dua masalah yang muncul berurutan dalam satu kasus nyata:
1. Transaksi Pemasukan dari foto struk transfer (tanpa menyebut nama dompet spesifik apa pun) tercatat masuk ke "Dompet Tabungan", bukan ke dompet primary (Dompet Utama) — mengulang pola masalah yang sama dengan Bug #3.
2. Selama transaksi itu tercatat di "Dompet Tabungan", transaksi tersebut **tidak muncul sama sekali** di halaman Riwayat Transaksi web. Baru setelah user mengoreksi dompetnya via WA (ganti ke "Dompet Utama"), transaksi tersebut langsung muncul dan tersinkron di web.

**Perbaikan yang diminta:**
- Perkuat kembali logic penentuan dompet primary (terkait dengan Bug #3): kalau tidak ada indikasi dompet sama sekali dari teks/foto, transaksi wajib masuk ke dompet yang ditandai primary di web, bukan dompet lain.
- Pastikan sinkronisasi data transaksi antara WA bot dan web berjalan 100% konsisten untuk **semua** dompet — tidak boleh ada kondisi di mana transaksi tercatat di sistem WA tapi tidak muncul/ter-sync di laporan web, apapun dompet tujuannya.

**Acceptance Criteria:**
- Transaksi tanpa indikasi dompet spesifik selalu masuk ke dompet primary yang diset di web.
- Semua transaksi yang tercatat via WA — ke dompet manapun — langsung muncul dan konsisten di laporan web tanpa perlu ada koreksi manual terlebih dahulu.

---

### Bug #5 — Scope Rekonsiliasi Tidak Dihormati
**Masalah:** Checkbox "Pilih Cakupan Dompet" di halaman Cross-check Saldo tidak difilter dengan benar — dompet yang tidak dicentang tetap dikirim/dianalisis oleh AI.
**Perbaikan yang diminta:**
- Saat tombol "Analisa dengan AI" ditekan, hanya kirim data dompet yang **dicentang** ke proses analisis (baik saldo sistem, input saldo aktual, maupun hasil perhitungan selisih).
- Dompet yang tidak dicentang tidak boleh muncul sama sekali di "Hasil Analisis AI", termasuk di ringkasan Total Saldo Aktual & Saldo Tercatat di App (hanya menjumlahkan dompet yang di-scope).

**Acceptance Criteria:**
- Jika hanya 1 dompet dicentang, hasil analisis AI hanya menampilkan & menghitung dompet tersebut — dompet lain benar-benar tidak muncul di hasil.

---

### Bug #6 — Input Teks Langsung untuk Saldo Terbaca
**Masalah:** Field "Saldo Terbaca" di kartu "Hasil Analisis AI" per dompet hanya menerima input dari upload foto/media.
**Perbaikan yang diminta:**
- Tambahkan opsi input teks langsung pada field "Saldo Terbaca" di setiap kartu dompet — user bisa mengetik nominal langsung, atau mengetik keterangan seperti "cash" yang lalu diproses/dikonversi sesuai konteks (tanpa perlu upload foto).
- Ini melengkapi (bukan menggantikan) opsi upload media yang sudah ada — user bebas pilih salah satu per dompet.
- Tidak perlu lagi keluar ke tombol "+ Tambah Manual" terpisah hanya untuk dompet yang tidak ada bukti fotonya.

**Acceptance Criteria:**
- Untuk setiap dompet dalam scope rekonsiliasi, user bisa mengisi "Saldo Terbaca" via foto ATAU input teks langsung dalam satu alur yang sama.

---

### Bug #9 — Auto-Update Insight AI Membaca Data Kosong
**Masalah:** Fitur "Ringkasan otomatis dari AI" di halaman Beranda dijadwalkan auto-update tiap tengah malam jam 00.00. Saat proses auto-update otomatis ini berjalan, AI menghasilkan ringkasan yang menyatakan kondisi keuangan kosong total (saldo Rp0, belum ada aktivitas), padahal data transaksi & saldo sebenarnya sudah ada. Ketika user melakukan refresh manual (tombol refresh), AI membaca data dengan benar dan insight-nya sesuai kondisi aktual.

**Perbaikan yang diminta:**
- Pastikan proses auto-update terjadwal jam 00.00 mengambil data dengan cara yang sama seperti proses refresh manual, sehingga hasilnya konsisten.
- Insight AI hasil auto-update tidak boleh menyatakan data kosong padahal data sebenarnya ada.

**Acceptance Criteria:**
- Hasil "Ringkasan otomatis dari AI" dari proses auto-update jam 00.00 sama akuratnya dengan hasil refresh manual — mencerminkan kondisi data yang sebenarnya.

---

## 3. Catatan untuk Antigravity
- Semua perbaikan ini termasuk dalam ekosistem [[aplikasi-keuangan]] (WA Bot Fase 7/8 + Web fitur Cross-check Saldo & Insight AI), share database Supabase yang sama.
- Bug #1–#4, #7, #8 di sisi WA bot (Bug #8 juga menyentuh sinkronisasi ke web); Bug #5, #6, #9 di sisi web.
- Prioritas pengerjaan disarankan sesuai urutan dampak: Bug #1, Bug #3 & #8 (salah dompet primary + gagal sync ke web — berulang, kemungkinan akar masalah sama), Bug #5 (analisis salah dompet), Bug #7 (utang-piutang gagal saat trigger eksplisit), dan Bug #9 (insight AI salah baca data terjadwal) berdampak langsung ke akurasi data, sebaiknya diprioritaskan terlebih dahulu.
- Root cause & metode implementasi perbaikan diserahkan sepenuhnya ke tim/AI eksekusi (Antigravity) — dokumen ini fokus pada deskripsi masalah & hasil akhir yang diharapkan.
