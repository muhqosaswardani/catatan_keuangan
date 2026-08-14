# PRD: Redesign Sistem Dompet — Fleksibel & Multi-Wallet (Web + WhatsApp Bot)

**Scope:** Web app (index.html) **dan** penyesuaian bot WhatsApp (Supabase Edge Function, V1 + V2) — keduanya digabung jadi 1 PRD karena berbagi database yang sama (`access_code` sama), sehingga perubahan struktur dompet di satu sisi otomatis berdampak ke sisi lain.
**Status:** Final draft, siap eksekusi.
**Referensi:** `Arsitektur-WA-Bot.md`, `Arsitektur-Web.md`.

---

## 1. Latar Belakang

Sistem dompet saat ini hardcoded 2 dompet default (`wallet_utama`, `wallet_tabungan`) yang tidak bisa dihapus. Semua fitur — web (transaksi, transfer, Goal, Utang, fitur Cek/AI reconciliation, Transaksi Cepat, dashboard) maupun bot WhatsApp (Mode Koreksi, Cek Saldo, transaksi bebas via teks/VN/foto) — berasumsi struktur ini fixed.

Redesign ini mengubah dompet jadi entitas fleksibel: user bisa punya berapa pun dompet (minimal 1), semua bisa diedit/dihapus/direname, dan salah satu ditandai sebagai **Dompet Primary**. Prinsip pembagian kerja: **manajemen dompet (CRUD, set primary, reorder) hanya ada di web**; bot WhatsApp berperan sebagai *read-consumer* dari struktur dompet ini — ia menyesuaikan cara bacanya, tapi tidak menambahkan kemampuan kelola dompet baru.

Dokumen ini terbagi 2 bagian: **Bagian A (§2–§11)** untuk perubahan di web, **Bagian B (§12–§16)** untuk penyesuaian logika bot WhatsApp yang mengikuti perubahan tersebut.

---

# BAGIAN A — WEB APP

## 2. Data Model

### 2.1 Wallet object (baru)
```
{
  id: string,
  name: string,
  balance: number,
  isPrimary: boolean,       // hanya 1 wallet yg true di seluruh list
  order: number,            // untuk sort manual di Kelola Dompet & dashboard
  createdAt: number,
  updatedAt: number
}
```

### 2.2 Deprecated
- Hardcoded ID `wallet_utama` / `wallet_tabungan` sebagai proteksi khusus → dihapus semua pengecekan `if(id === 'wallet_utama' ...)`.
- Semua proteksi "gak bisa dihapus" pindah ke logic `isPrimary` (primary gak bisa dihapus, non-primary bebas).

---

## 3. Migrasi Data Lama

1. **Saldo dipertahankan**, tidak direset, untuk semua dompet existing.
2. Dompet lama `wallet_utama` dan `wallet_tabungan` jadi dompet biasa (bisa diedit/dihapus/direname) — **kecuali** salah satunya harus jadi primary dulu (lihat poin 3).
3. **Primary default saat migrasi**: `wallet_utama` (lama) otomatis jadi `isPrimary: true`.
4. Migrasi one-time, jalan otomatis saat load pertama kali setelah update (deteksi via version flag di config, mirip pola migrasi yang sudah ada di app).

### 3.1 Fresh install (user baru)
- Tetap ada flow onboarding tanya saldo awal (behavior lama dipertahankan).
- 1 dompet default dibuat dengan `isPrimary: true`, nama default (misal "Dompet Utama", user bisa edit nanti).
- Ada opsi langsung di layar onboarding untuk "+ Tambah Dompet" lain sebelum mulai — dompet tambahan yang dibuat **di layar onboarding ini juga ditanya saldo awal**, sama seperti dompet pertama (masih dalam 1 alur onboarding, belum masuk app).
- Saldo awal **hanya diminta selama masih di layar onboarding**. Begitu user sudah masuk/menyelesaikan onboarding, tidak ada lagi field "saldo awal" di mana pun (termasuk saat tambah dompet baru dari Kelola Dompet setelahnya) — dompet baru selalu mulai dari saldo 0, penyesuaian saldo dilakukan lewat fitur edit saldo (lihat §5).

---

## 4. Kelola Dompet (Modal Settings)

Lokasi: Pengaturan → Kelola Dompet.

### 4.1 Aksi per dompet
| Aksi | Behavior |
|---|---|
| Edit nama | Bebas, real-time |
| Edit saldo | Klik nominal → jadi field editable → replace value → generate transaksi penyesuaian (lihat §5) |
| Hapus | Bebas, KECUALI dompet primary — harus pindahkan primary dulu. Kalau dompet masih punya riwayat transaksi, munculkan **dialog konfirmasi peringatan** sebelum hapus (lihat §4.2.1) |
| Set sebagai primary | Radio/toggle, hanya 1 aktif |
| Reorder | Drag & drop, mirip UX sort tombol nav/kategori existing. Primary **selalu posisi 1**, tidak ikut di-drag (dia otomatis nomor 1). Sisanya (posisi 2, dst) bebas diatur user. |
| Tambah dompet baru | Tombol "+ Tambah Dompet", saldo awal langsung 0, tanpa nanya saldo awal |

### 4.2 Validasi
- Minimal 1 dompet selalu ada di sistem — tombol hapus disabled kalau tinggal 1 dompet tersisa.
- Primary tidak bisa dihapus. Kalau user coba hapus dompet primary → munculkan pesan "Pindahkan status primary ke dompet lain dulu" (bukan hard block tanpa penjelasan).

### 4.2.1 Nasib Transaksi Historis Saat Dompet Dihapus
- Menghapus dompet **tidak menghapus riwayat transaksi** di dalamnya. Transaksi lama (termasuk sisi asal/tujuan dari transaksi **Transfer** yang melibatkan dompet itu) tetap ada di riwayat, hanya labelnya berubah jadi **"Dompet Terhapus"** (bukan nama dompet asli).
- Transaksi dengan label "Dompet Terhapus" tetap dihitung normal di laporan/analisis (tidak otomatis exclude) — kecuali transaksi itu sendiri sudah punya `exclude_from_report: true` dari sononya (misal transaksi penyesuaian saldo).
- **Wajib ada dialog konfirmasi** sebelum hapus kalau dompet yang mau dihapus masih punya ≥1 transaksi tercatat: tampilkan jumlah transaksi terkait, jelaskan bahwa transaksi tidak akan hilang tapi labelnya berubah jadi "Dompet Terhapus", minta user konfirmasi eksplisit (bukan langsung hapus sekali klik). Kalau dompet kosong (0 transaksi), hapus langsung tanpa dialog ini.

### 4.3 Soal "kecualikan dari laporan"
**Klarifikasi penting:** field `excludeFromReport` di level **dompet TIDAK ADA**. Yang ada adalah field `exclude_from_report` di level **transaksi penyesuaian saldo** (field ini sudah ada di sistem transaksi, dipakai ulang, bukan bikin baru).
- Saat generate transaksi penyesuaian dari edit saldo, muncul checkbox "Kecualikan dari laporan" untuk transaksi itu spesifik.
- **Default checkbox: ON (tercentang)** — jadi transaksi penyesuaian secara default tidak masuk hitungan laporan/analisis, kecuali user uncheck manual.
- Ini tidak memengaruhi fungsi dompet itu sendiri sama sekali — dompetnya tetap normal, transaksi lain di dalamnya tetap masuk laporan seperti biasa.

---

## 5. Edit Saldo → Transaksi Penyesuaian Otomatis

### 5.1 Trigger
User klik nominal saldo dompet di Kelola Dompet → field jadi editable → input nilai baru → simpan.

### 5.2 Logic
1. Sistem hitung `delta = nilai_baru - saldo_lama`.
2. Kalau `delta === 0` → **tidak ada transaksi dibuat**, langsung save saja (no-op).
3. Kalau `delta !== 0` → generate 1 transaksi baru:
   - Kategori: **Penyesuaian Saldo** (kategori yang sudah ada, dipakai ulang, tidak bikin kategori baru).
   - Jenis: income kalau delta positif, expense kalau delta negatif.
   - Nominal: `abs(delta)`.
   - Tanggal: **default hari ini**, tidak ada input tanggal manual.
   - Dompet: dompet yang diedit.
   - `exclude_from_report`: default **true** (checkbox tercentang), user bisa uncheck sebelum simpan.
4. Saldo dompet langsung ter-update ke nilai baru (replace, bukan tambah/kurang manual oleh user).

### 5.3 Yang TIDAK berubah
- Laporan/analisis existing sudah punya logic exclude berdasarkan `exclude_from_report` — dipakai ulang apa adanya, tidak ada perubahan ke fungsi laporan.

---

## 6. Konsep Dompet Primary

### 6.1 Fungsi (hanya 2, tidak lebih)
1. **Default terpilih** saat user bikin transaksi baru (manual/quick add).
2. **Fallback tujuan** kalau fitur Cek (AI) tidak menemukan kecocokan dompet untuk suatu item.

### 6.2 Yang TIDAK terpengaruh oleh primary
- Kartu "Total Saldo" di Beranda **tetap pakai checklist `heroWallets` terpisah** seperti sekarang — primary tidak otomatis masuk/keluar dari perhitungan Total Saldo. Primary hanyalah default target transaksi, bukan penentu apa yang dihitung di Total Saldo.

### 6.3 Constraint
- Dompet primary tidak bisa dihapus sebelum primary dipindahkan ke dompet lain dulu (lihat §4.2).
- Saat pindah primary, dompet lama otomatis jadi non-primary biasa (saldo tidak berubah).

---

## 7. Fitur "Cek" (AI Reconciliation dari Foto/Teks)

Ini bagian paling kompleks — perubahan dari single-wallet ke multi-wallet reconciliation.

### 7.1 Alur baru
1. User **tetap memilih dompet mana saja yang mau di-scope** untuk sesi Cek ini (checklist dompet).
   - Template default: **semua dompet tercentang**, user bisa uncheck yang tidak relevan.
   - State checklist **disimpan** (bukan reset tiap buka) — pakai checklist terakhir yang dipilih user.
2. User upload foto/teks (bisa banyak sekaligus, tiap foto = 1 sumber, bisa multiple item per foto — behavior existing dipertahankan).
3. AI (Gemini) baca tiap item, coba **cocokkan berdasarkan konteks/kategori dompet, bukan exact name match**.
   - Contoh: dompet disimpan user dengan tipe/nama "Ewallet" → AI scan hasil "GoPay", "Dana", "OVO" dsb → semua dicocokkan ke dompet "Ewallet" itu.
   - Contoh: dompet "Bank Mandiri" → AI scan screenshot m-banking "Livin by Mandiri" → tetap dicocokkan ke situ.
   - AI (Gemini) yang menentukan logic pencocokan berdasarkan pemahaman konteks nama/jenis institusi, bukan string matching kaku. Setiap match harus disertai **alasan singkat** yang ditampilkan ke user (misal: "GoPay → Ewallet, karena termasuk e-wallet").
   - **Ambiguitas nama dompet mirip:** kalau ada ≥2 dompet user yang sama-sama masuk akal jadi tujuan match (misal user punya dompet "GoPay Utama" dan "GoPay Bisnis", hasil scan cuma tertulis "GoPay" generik tanpa keterangan lebih spesifik) → item ini **wajib ditandai butuh klarifikasi** di laporan hasil Cek (statusnya sama seperti item "tidak ketemu kecocokan" di §7.3, pakai dropdown assign manual yang sama), AI tidak boleh menebak salah satu secara diam-diam.
4. **Tidak dijumlah jadi 1 total** seperti sekarang — tiap item hasil scan berlaku sebagai penyesuaian **per-dompet masing-masing** (satu-satu, terpisah).

### 7.2 Cash / Uang Tunai
- Item yang teridentifikasi sebagai "cash/uang tunai" **tanpa dompet yang cocok secara pendekatan/konteks** → otomatis masuk ke **dompet primary** + diberi **tanda visual** bahwa ini butuh dicek/disesuaikan user.
- Tidak ada dompet bertipe khusus "cash" yang wajib di-setup di awal — fallback-nya primary.

### 7.3 Item yang tidak ketemu kecocokan dompet (bukan hanya cash)
- Sama seperti cash: default masuk ke **dompet primary**, diberi **tanda** untuk direview.
- Muncul **dropdown assign manual** di samping item itu berisi daftar dompet, supaya user bisa pindahkan ke dompet yang benar.
  - Dropdown berisi **semua dompet yang ada** (termasuk yang punya transaksi ditandai exclude dari laporan — karena exclude itu levelnya transaksi, bukan dompet, jadi tidak ada dompet yang "disembunyikan" dari opsi manapun).
  - Ada opsi **"+ Tambah Dompet Baru"** di dropdown itu:
    - Buka form kecil, nama otomatis terisi dari nama yang dibaca AI (misal "Bank Jago"), tapi tetap bisa diedit manual.
    - Dompet baru ini dibuat dengan **saldo awal 0**, lalu kena 1 transaksi penyesuaian +nilai yang dibaca AI — supaya riwayatnya tetap tercatat jelas di Riwayat Penyesuaian Saldo (bukan langsung "disulap" jadi sudah sesuai tanpa jejak).

### 7.4 Duplikasi / multiple match ke dompet yang sama
- Kalau 2+ hasil scan match ke dompet yang sama:
  - **Nilai identik persis** → dianggap duplikasi (misal user scan 2 foto yang sama), ambil **1 saja**.
  - **Nilai berbeda** → yang terbaru **menimpa** (bukan dijumlah), dan diberi **tanda** supaya user sadar ada override dan bisa cek manual mana yang benar.

### 7.5 Apply Penyesuaian
- Tombol "Terapkan Penyesuaian" men-generate **transaksi penyesuaian saldo terpisah per dompet** yang punya selisih (bukan 1 transaksi gabungan).
  - Contoh: GoPay +50rb, Bank Mandiri -20rb, 1 item manual assign ke Dompet Kas +10rb → hasilnya **3 transaksi penyesuaian** tercatat sekaligus.
- Semua transaksi penyesuaian ini pakai kategori "Penyesuaian Saldo" yang sama, `exclude_from_report` default sesuai setting adjustment normal (default true, bisa diubah per-transaksi kalau perlu — atau ikut default global, TBD saat implementasi, tidak signifikan karena sudah pakai fungsi existing).

### 7.6 Laporan hasil Cek
- Bukan lagi menampilkan 1 angka total selisih, tapi **laporan detail per-dompet**: dompet mana, nilai lama, nilai AI, selisih, status (cocok/butuh cek/duplikat/ditimpa).

---

## 8. Fitur "Transaksi Cepat" (AI baca transaksi harian)

- **Tidak berubah secara struktural** seperti fitur Cek. Tetap 1 dompet dipilih di awal per transaksi.
- **Perubahan kecil**: sistem bisa menyarankan dompet default berdasarkan **kebiasaan/frequency pemakaian** (dompet mana yang paling sering dipakai untuk jenis transaksi serupa) — sifatnya suggestion/pre-select, bukan auto-match multi-dompet seperti fitur Cek.

---

## 9. Goal (Tujuan Nabung) & Pelunasan Utang

- **Tidak berubah.** Tetap terikat ke 1 dompet spesifik.
- Kalau dompet yang terikat dihapus → Goal/Utang terkait **ikut terhapus otomatis** (behavior existing dipertahankan).

---

## 10. Transfer Antar Dompet, Filter Transaksi, Transaksi Berulang (Recurring)

- **Tidak ada perubahan behavior.** Semua fitur ini sudah dinamis (menampilkan seluruh dompet yang ada), otomatis menyesuaikan jumlah dompet yang sekarang fleksibel.

---

## 11. Dashboard — Box Hijau (Hero Card)

### 11.1 Layout
- **Tidak ada pop-up/modal terpisah lagi** untuk "tampilkan semua dompet".
- Di bawah border box hijau, ada tulisan **"Lihat semua dompet"** (link/tombol text, bukan modal).
- Link ini **disembunyikan** kalau jumlah dompet yang tercentang di checklist `heroWallets` ≤ 2 — karena expand tidak menambah informasi apapun (yang muncul di expanded sama persis dengan collapsed).

### 11.2 Collapsed (default)
- Box hijau nampilin **2 dompet saja**, sesuai urutan yang di-set di Kelola Dompet.
- Dompet urutan pertama **selalu primary** (fixed, tidak perlu diatur manual). Urutan kedua sesuai drag-reorder manual user.
- Ini berlaku **selalu 2**, terlepas dari berapa banyak dompet yang tercentang di checklist `heroWallets` (bisa 5 dompet dicentang, tetap cuma 2 yang tampil di collapsed state) — kecuali total tercentang ≤2, di mana collapsed dan expanded otomatis identik (lihat §11.1).

### 11.3 Expanded (klik "Lihat semua dompet")
- Box hijau **expand ke bawah** (melebarkan tinggi box tampilan itu sendiri, inline — bukan pop-up/modal terpisah), menampilkan **semua dompet yang tercentang di checklist `heroWallets`**.
- Klik lagi (collapse) → balik ke tampilan 2 dompet saja.

### 11.4 Kartu "Total Saldo"
- Angka besar di atas box hijau **tidak berubah** — tetap jumlah dari semua dompet yang tercentang `heroWallets`, tidak terpengaruh expand/collapse ataupun status primary.

---

# BAGIAN B — BOT WHATSAPP

Prinsip utama Bagian B: bot WA tetap "read-consumer" dari struktur dompet, bukan pengelola dompet. Manajemen dompet (tambah/hapus/rename/set primary/reorder) **tetap eksklusif di web** (Bagian A §4), tidak ditambahkan ke WA.

## 12. Perubahan Fundamental: Hardcoded ID → Logic `isPrimary`

Sama seperti di web, semua referensi ke `wallet_utama` / `wallet_tabungan` di codebase bot (V1 maupun V2) harus diganti ke logic dinamis berbasis field `isPrimary` dan `order` dari tabel `wallets`.

Titik-titik yang teridentifikasi butuh perubahan (berdasarkan `Arsitektur-WA-Bot.md`):

| Lokasi | Perilaku lama | Perilaku baru |
|---|---|---|
| Dompet default transaksi bebas (teks/VN/foto tanpa sebut dompet, di V1 & Transaksi Cepat) | Default ke `wallet_utama` (hardcoded) | Default ke dompet dengan `isPrimary: true` |
| Fallback item "cash"/tak ketemu match dompet di Mode Koreksi | — (belum ada konsep ini di WA) | Masuk ke dompet primary + ditandai perlu direview di bubble laporan |
| Urutan tampil daftar dompet (numbered list Mode Koreksi, breakdown "Cek Saldo") | Urutan tidak eksplisit / asumsi 2 dompet tetap | Ikut field `order`; **dompet primary selalu tampil nomor 1** (fixed, sama seperti hero card web), sisanya sesuai `order` |
| Pemetaan sub-akun e-wallet ("Layout Rekap Terstruktur" existing) | Hardcode "e-wallet dipetakan ke `Dompet Utama`" | Dipetakan berdasarkan context matching Gemini ke dompet yang **dipilih user di Langkah 1** (lihat §14), bukan otomatis ke satu dompet tertentu |
| `heroWallets` / total saldo di "cek saldo" | — | Tidak berubah — WA tetap tampilkan breakdown semua dompet lalu total (§16), tidak mengikuti checklist `heroWallets` (itu murni konsep display web) |

---

## 13. Yang TIDAK Berubah di Bot WA (Konfirmasi Eksplisit)

- **Manajemen dompet** (tambah/hapus/rename/set primary/reorder) — **tidak ditambahkan ke WA**. Kalau user coba lakukan ini via chat (misal ketik "tambah dompet baru"), bot cukup arahkan: "Kelola dompet bisa dilakukan lewat aplikasi web di menu Pengaturan → Kelola Dompet."
- **Transfer Antar Dompet**, **Checklist Lunas**, **Utang-Piutang** — logic sudah dinamis (baca semua dompet yang ada dari DB), tidak butuh perubahan struktural. Hanya perlu memastikan tidak ada asumsi 2-dompet tersembunyi di kode (audit saja, lihat §18.2).
- **Mode Limit/Anggaran** dan **Mode Tujuan Tabungan** — tidak terkait dompet, tidak berubah.
- **Sistem Query Anti-Halusinasi** (Tahap Deterministik + Gemini Packaging) — tidak berubah, query tinggal ambil dompet apa adanya dari DB.

---

## 14. Perubahan pada Mode "Koreksi" (Penyesuaian Saldo via WA)

Ini bagian dengan perubahan paling signifikan, karena Mode Koreksi WA adalah versi lite dari fitur "Cek" web (§7) — sekarang perlu mengadopsi sebagian logic barunya, tapi **tetap mempertahankan langkah pemilihan dompet manual** (beda dari web yang defaultnya semua dompet tercentang).

### 14.1 Langkah 1 — Pilihan Dompet (tetap ada, disesuaikan)
- Tetap menampilkan **daftar dompet bernomor**, urutannya ikut `order` + primary di nomor 1 (lihat §12).
- Tetap mendukung pilih multi-dompet dalam 1 sesi (misal ketik `"1 2"` atau `"1 2 4"`), dan shortcut `"semua"` / `"all"`.
- Dompet yang dipilih di langkah ini menjadi **scope pencocokan** untuk sesi koreksi tersebut — bukan lagi 1 dompet per sesi.

### 14.2 Langkah 2 — Kirim Foto/Nilai (context matching, bukan exact match lagi)
- User kirim foto screenshot m-banking/e-wallet (bisa multi-foto sekaligus, tetap didukung) atau ketik nilai cash langsung.
- Gemini membaca tiap item/sub-akun, lalu **mencocokkan ke salah satu dompet yang dipilih di Langkah 1** berdasarkan konteks nama/jenis institusi (bukan exact string match) — logic sama seperti fitur Cek web §7.3:
  - Contoh: dompet dipilih user "Ewallet" → screenshot "GoPay"/"Dana"/"OVO" dicocokkan ke situ.
  - Contoh: dompet dipilih "Bank Mandiri" → screenshot "Livin by Mandiri" dicocokkan ke situ.
- **Item yang tidak cocok dengan dompet manapun yang dipilih (termasuk cash tanpa dompet cash yang dipilih)** → otomatis masuk ke **dompet primary**, ditandai di bubble laporan sebagai "perlu dicek" (bukan silent).
  - Beda dari web: karena WA tidak punya dropdown, cara pindahkannya via sub-perintah teks yang sudah ada — sebut nomor item + nama dompet tujuan (pola sama seperti sub-perintah existing: `"gopay 16.300"`, `"hapus 2"`).

### 14.3 Duplikasi / Multiple Match ke Dompet yang Sama
Sama seperti web §7.4, diterapkan juga di WA:
- **Nilai identik persis** (misal user re-upload foto yang sama) → dianggap duplikat, ambil 1 saja, tidak dobel di rincian.
- **Nilai berbeda** untuk dompet yang sama → yang **terbaru menimpa** (bukan dijumlah), diberi tanda di rincian bubble supaya user sadar ada override dan bisa cek manual.

### 14.4 Laporan & Konfirmasi (tidak berubah dari desain existing)
- Tetap **1 bubble laporan** berisi seluruh rincian per-dompet (dompet, nilai lama, nilai terbaca, selisih, status: cocok/perlu cek/duplikat/ditimpa) + alasan singkat pencocokan tiap item (mis. "GoPay → Ewallet, karena termasuk e-wallet").
- Tetap bisa ditambah/di-replace/dihapus item sebelum konfirmasi.
- Ketik `"ya"`/`"oke"` → generate **transaksi penyesuaian terpisah per dompet** yang punya selisih (bukan 1 transaksi gabungan) — konsisten dengan web §5 & §7.5. Semua transaksi ini kategori "Penyesuaian Saldo", `exclude_from_report` default `true` (tidak ada opsi uncheck via WA — kalau user mau exclude=false, itu dilakukan lewat web di riwayat transaksi setelahnya).
- Setelah konfirmasi berhasil → **langsung keluar mode otomatis** + notif nilai dompet terbaru (behavior existing dipertahankan, tidak berubah).
- `"batal"` (exact) tetap keluar mode tanpa proses apapun.

### 14.5 Yang Sengaja Tidak Diadopsi dari Web
- **Tidak ada opsi "+ Tambah Dompet Baru" inline** di WA (sudah dikonfirmasi user — manajemen dompet tetap web-only). Item yang tidak cocok dengan dompet manapun **selalu** jatuh ke primary + tanda, tidak pernah memicu pembuatan dompet baru dari WA.

---

## 15. Dompet Default untuk Transaksi Bebas & Transaksi Cepat

- Semua alur pencatatan transaksi biasa (V1 parsing bebas, VN, foto struk, Transaksi Cepat) yang **tidak menyebut dompet secara eksplisit** → default ke dompet primary (ganti dari hardcode `wallet_utama`).
- Fitur suggestion dompet berdasarkan kebiasaan/frequency (sudah ada di roadmap Transaksi Cepat web §8) — kalau nanti diimplementasi juga di WA, suggestion ini override default primary, tapi primary tetap fallback kalau tidak ada histori.
- Penyebutan dompet eksplisit oleh user (misal "beli kopi 15k dari gopay") tetap diprioritaskan seperti sekarang — tidak terpengaruh perubahan ini.

---

## 16. "Cek Saldo" (Query Cepat, Bukan Mode Koreksi)

- Format balasan tidak berubah secara isi: breakdown per dompet dulu, baru total di bawah.
- **Urutan breakdown** disamakan dengan urutan Kelola Dompet di web: primary di posisi pertama, sisanya ikut `order`.
- Sumber `bold`-nya per baris nominal masih PR lama dari Fase 7 (dicatat di memori, di luar scope PRD ini) — tidak diulang di sini.

---

## 17. Ringkasan Perubahan per Komponen (Gabungan)

### 17.1 Web
| Fitur | Berubah? | Detail |
|---|---|---|
| Kelola Dompet | ✅ Redesign total | Modal baru: edit nama/saldo, primary, reorder, hapus fleksibel |
| Fitur Cek (AI reconciliation) | ✅ Redesign total | Multi-dompet, context-based matching, per-dompet adjustment |
| Edit saldo dompet | ✅ Baru | Replace value → auto transaksi penyesuaian |
| Dashboard hero card | ✅ Redesign | Expand/collapse inline, bukan pop-up |
| Transaksi Cepat (AI) | 🟡 Minor | Suggest dompet by kebiasaan, tetap single-select |
| Goal / Utang | ⬜ Tidak berubah | Tetap cascade delete |
| Transfer / Filter / Recurring | ⬜ Tidak berubah | Sudah dinamis |
| Onboarding fresh install | 🟡 Minor | Tambah opsi "+ Tambah Dompet" di layar awal |
| Migrasi data lama | ✅ Baru | One-time migration, saldo dipertahankan |

### 17.2 Bot WhatsApp
| Komponen | Berubah? | Detail |
|---|---|---|
| Referensi hardcoded `wallet_utama`/`wallet_tabungan` di kode bot | ✅ Wajib | Ganti ke logic `isPrimary` (§12) |
| Mode Koreksi — pilihan dompet (Langkah 1) | 🟡 Minor | Tetap ada, urutan ikut `order`+primary nomor 1, tetap multi-select |
| Mode Koreksi — pencocokan item (Langkah 2) | ✅ Redesign | Context matching Gemini per item (bukan hanya breakdown sub-akun e-wallet ke 1 dompet tetap), fallback ke primary + tanda utk unmatched |
| Mode Koreksi — duplikasi/override | ✅ Baru | Adopsi logic web §7.4 (identik = duplikat, beda = override + tanda) |
| Transaksi penyesuaian saldo dari Mode Koreksi | 🟡 Minor | Tetap 1 transaksi per dompet yang berubah, `exclude_from_report` default true (tanpa opsi uncheck via WA) |
| Dompet default transaksi bebas / Transaksi Cepat | ✅ Wajib | Primary dinamis, bukan hardcoded |
| Cek Saldo (query cepat) | 🟡 Minor | Urutan breakdown ikut `order`+primary |
| Transfer Antar Dompet | ⬜ Tidak berubah | Sudah dinamis |
| Checklist Lunas, Utang-Piutang, Mode Limit, Mode Tujuan | ⬜ Tidak berubah | Tidak terkait struktur dompet |
| Manajemen dompet (CRUD, set primary, reorder) via WA | ⬜ Tidak ditambahkan | Tetap eksklusif web, WA cukup arahkan ke web kalau diminta |

---

## 18. Hal yang Perlu Diperhatikan Saat Implementasi (Engineering Notes)

### 18.1 Web
- Semua pengecekan hardcoded `id === 'wallet_utama' || id === 'wallet_tabungan'` di codebase (ditemukan di ±6 lokasi: proteksi hapus, badge default, seed data, referensi total saldo tabungan) harus diganti ke logic `isPrimary`.
- Perlu cek ulang baris yang exclude `wallet_tabungan` dari perhitungan tertentu (misal total saldo non-tabungan) — pastikan concept ini di-translate dengan benar ke sistem baru atau memang dihapus karena sudah tidak relevan (tidak ada lagi "tabungan" sebagai kategori spesial).
- `heroWallets` default value (`['wallet_utama']`) perlu diganti ke default dinamis: primary wallet's ID saat pertama kali config dibuat.
- Field `order` di wallet perlu migration script untuk assign nilai awal (urutan existing = createdAt ascending, primary otomatis dianggap order 0).
- Karena dompet sekarang bisa dihapus tapi transaksinya tetap ada (lihat §4.2.1), pastikan skema transaksi tidak pakai hard foreign-key constraint yang otomatis cascade-delete ke `wallet_id` — perlu soft-reference (id tetap tersimpan di transaksi walau dompetnya sudah tidak ada di tabel `wallets`, tampilan baca nama fallback ke "Dompet Terhapus" kalau lookup gagal).
- Status "butuh klarifikasi" akibat ambiguitas nama dompet mirip (§7.1) dan status "tidak ketemu kecocokan" (§7.3) memakai UI dan field status yang sama di laporan hasil Cek — tidak perlu status ketiga terpisah, cukup dibedakan di alasan/pesan yang ditampilkan ke user.

### 18.2 Bot WhatsApp
- Audit dan ganti semua `if(id === 'wallet_utama' ...)` / sejenisnya di file-file V1 dan V2 (`v2_router.ts`, `v2_modes.ts`, `v2_intents.ts`, `v2_db.ts`, dan fallback V1 di edge function utama) — cari juga di query Supabase yang mem-filter atau meng-hardcode nama dompet di prompt Gemini (khususnya prompt "breakdown sub-akun e-wallet" yang saat ini eksplisit menyebut "Dompet Utama").
- `wa_mode_sessions.session_data` (JSONB) untuk mode `koreksi` perlu diperluas menyimpan: daftar dompet yang dipilih di Langkah 1 (scope), per-item hasil matching (dompet target, alasan, status: cocok/perlu-cek/duplikat/ditimpa), supaya proses tambah/edit/hapus item sebelum konfirmasi tetap didukung dalam 1 sesi seperti sekarang.
- Query "daftar dompet untuk ditampilkan bernomor" (dipakai di Langkah 1 Mode Koreksi & referensi lain) diseragamkan jadi 1 helper function di `v2_db.ts` yang `ORDER BY` primary dulu lalu `order` — dipakai ulang di semua tempat yang butuh urutan dompet (hindari logic duplikat tersebar).
- Karena migrasi data dompet (primary default, field `order`) dijalankan oleh **web** (one-time migration saat load pertama, sesuai §3), bot WA tidak perlu migration script sendiri — cukup pastikan bot membaca field `isPrimary`/`order` yang sudah ada setelah migrasi web berjalan. **Urutan deploy yang direkomendasikan: web dulu, baru bot** — supaya tidak ada window di mana bot query field yang belum terisi.
- Konsisten dengan pola rollback existing: perubahan ini masuk sebagai bagian dari modul `v2_` yang sudah ada (bukan modul baru terpisah), tetap di bawah kendali flag `WA_V2_ENABLED` yang sama.
