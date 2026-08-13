# PRD — Integrasi WhatsApp untuk Catatan Keuangan
**Fase Tambahan (Fase 7) — Dokumen kerja untuk Antigravity IDE**
Versi: 2.1 · Dibuat: 10 Agustus 2026 · Diperbarui: 12 Agustus 2026

*Dokumen ini adalah lanjutan/addendum dari `PRD-Catatan-Keuangan.md` (Fase 1–6, sudah selesai: Supabase, sinkronisasi, dan sedang menuju build APK). Fase ini boleh dikerjakan sebelum ATAU sesudah Fase 4 (Capacitor & APK) — tidak saling bergantung, tapi sama-sama butuh Supabase yang sudah aktif dari Fase 1.*

**Perubahan besar di versi 2.0**: (1) nomor WhatsApp Business yang dipakai adalah **nomor pribadi pemilik produk sendiri** (081226964679, sudah berhasil diregistrasi di Meta), BUKAN nomor test Meta seperti rencana awal — lihat bagian 17. (2) Parsing AI di WA **menggunakan ulang (reuse) logic "Analisis Transaksi AI"** yang sudah ada & battle-tested di aplikasi utama (fungsi `aiScanWithGemini`/`callGeminiRaw`, prompt, dan schema yang sama persis) — bukan logic baru terpisah. (3) Alur WA **langsung simpan tanpa konfirmasi dulu** (beda dari web yang mewajibkan review sebelum simpan), dengan fitur baru **reply-to-edit/delete** lewat bubble chat WA.

---

## 1. OVERVIEW

Menambahkan kemampuan mencatat transaksi keuangan **lewat chat WhatsApp biasa**, memakai WhatsApp dari HP pribadi pemilik produk sendiri (081226964679, sudah menjadi nomor WhatsApp Business terdaftar) — tanpa install aplikasi baru.

Pemilik produk mengetik pesan bebas ("makan 25000", "gaji masuk", "nasi kuning"), mengirim satu/beberapa foto bebas (struk maupun bukan struk, mis. foto barang yang dibeli), atau **mengirim pesan suara (voice note)** — pesan itu diproses memakai **logic Analisis Transaksi AI yang SUDAH ADA** di aplikasi utama (prompt & schema Gemini yang sama persis, diperluas untuk audio — lihat bagian 4a & 5.2b), diubah jadi satu atau beberapa transaksi terstruktur, **langsung disimpan** ke Supabase (database yang sama dengan aplikasi utama — kecuali item yang nominalnya belum jelas, lihat 5.1a), dan dibalas konfirmasi lewat WA — **satu bubble balasan terpisah per transaksi**, yang bisa **di-reply langsung untuk edit/hapus transaksi itu** (lihat bagian 5.7).

## 2. GOALS

- Mencatat transaksi tanpa buka aplikasi sama sekali — cukup chat WA.
- Mendukung teks bebas (bukan format kaku), foto bebas (struk maupun bukan struk, mis. foto barang yang dibeli, termasuk kirim beberapa foto sekaligus), **dan pesan suara (voice note) — diproses langsung oleh Gemini sebagai audio tanpa tahap transkripsi teks terpisah**.
- **Reuse logic AI yang sudah ada** (Analisis Transaksi AI) — bukan bikin sistem parsing baru dari nol, supaya perilakunya konsisten dengan yang sudah dikenal & diuji di aplikasi utama.
- Transaksi langsung tersimpan tanpa perlu konfirmasi manual dulu (beda dengan web) — tapi tetap bisa dikoreksi lewat reply.
- **Setiap transaksi hasil AI dibalas sebagai bubble WA terpisah**, dan pemilik produk bisa **reply ke bubble itu untuk edit/hapus** transaksi tsb secara spesifik.
- Bot merespons natural (hasil AI, bukan jawaban template kaku) untuk pesan yang ambigu.
- Data yang tersimpan lewat WA masuk ke database yang SAMA dengan aplikasi utama (Supabase) — langsung muncul di web/APK begitu sinkron.
- Semua biaya tetap **Rp0** (gratis).
- Tidak menyimpan foto (struk maupun bukan struk) secara permanen di mana pun milik pemilik produk.

## 3. NON-GOALS (TIDAK dikerjakan di fase ini)

- Fitur promosi/broadcast/notifikasi proaktif dari bot ke pemilik produk (mis. pengingat otomatis lewat WA) — bot hanya membalas pesan yang masuk, tidak pernah memulai chat sendiri.
- Multi-user / banyak nomor WA yang bisa chat ke bot ini — tetap single-user, hanya nomor pribadi pemilik produk sendiri yang chat ke nomor Business-nya.
- Backend server yang harus "dijaga nyala" 24 jam — dipakai pendekatan serverless (Supabase Edge Function), bukan VPS/server tradisional.
- Membuat ulang/mendesain ulang logic parsing AI — WAJIB reuse logic Analisis Transaksi AI yang sudah ada di aplikasi utama (lihat bagian 4a), bukan menulis prompt/schema Gemini baru dari nol.
- **Tahap transkripsi suara-ke-teks terpisah** untuk pesan suara — audio dikirim langsung ke Gemini untuk dipahami sekaligus diekstrak jadi transaksi dalam satu panggilan (lihat bagian 5.2b), BUKAN alur "transkrip dulu jadi teks, baru teks itu diparse terpisah".

## 4. ARSITEKTUR

```
WhatsApp pribadi pemilik produk
        ↓ (teks / 1-banyak foto + caption / pesan suara)
Nomor WhatsApp Business "Catatan Keuangan" (081226964679, Cloud API resmi Meta)
        ↓
Webhook — Supabase Edge Function
        ↓
Gemini API (text, vision, & audio understanding) — REUSE logic "Analisis Transaksi AI" yang sudah ada (bagian 4a)
        ↓
Tabel `transactions` di Supabase (sama dengan aplikasi utama) — simpan langsung per objek hasil
        ↓
Balasan konfirmasi per transaksi dikirim balik ke WhatsApp — 1 bubble = 1 transaksi (bagian 5.6)
        ↓
Pemilik produk bisa REPLY ke bubble manapun untuk edit/hapus transaksi itu (bagian 5.7)
```

**Keputusan arsitektur kunci:**
- **Backend = Supabase Edge Function** (serverless, "bangun cuma pas dipanggil") — BUKAN server yang nyala terus 24 jam. Cocok karena Cloud API bersifat event-driven (dipanggil Meta cuma pas ada pesan masuk), bukan koneksi yang harus terus tersambung.
- **Tidak ada Google Cloud Project baru** — Gemini API Key yang sudah dipakai aplikasi utama, dipakai ulang di sini.
- **Tidak ada BSP pihak ketiga** — langsung pakai WhatsApp Cloud API resmi dari Meta, dengan nomor pribadi pemilik produk sendiri (lihat bagian 17).
- **Foto TIDAK PERNAH ditulis ke storage** (Supabase Storage atau disk manapun) — diambil dari Meta, diproses langsung di memori Edge Function, dikirim ke Gemini, lalu dibuang begitu function selesai. Yang disimpan permanen cuma hasil JSON teksnya.

## 4a. REUSE LOGIC "ANALISIS TRANSAKSI AI" YANG SUDAH ADA (WAJIB, bukan opsional)

Aplikasi utama (`index.html`) sudah punya fitur **Analisis Transaksi AI** yang matang — fungsi `aiScanWithGemini()`, `callGeminiRaw()`, daftar `GEMINI_MODELS` dengan fallback berurutan, dan prompt Gemini yang sangat detail (menangani: struk itemized dengan grouping per kategori + alokasi proporsional dari 1 total, mutasi m-banking baris per baris, foto bebas non-struk, teks bebas dengan slang/typo Indonesia, format nominal informal seperti "25rb"/"2,5"/"goceng", validasi ketat kapan boleh menolak input, dsb) beserta `transactionSchema` (JSON schema constrained decoding) yang sudah teruji.

**Instruksi WAJIB untuk Antigravity**: Edge Function WA **memanggil ulang PROMPT & SCHEMA YANG SAMA PERSIS** dengan yang dipakai `aiScanWithGemini()` di `index.html` (termasuk seluruh aturan validasi, grouping per kategori, dan penanganan slang/nominal informal) — bukan menulis prompt baru dari nol untuk WA. Kalau prompt di `index.html` diperbarui di kemudian hari, versi yang dipakai Edge Function WA harus ikut diperbarui juga (idealnya satu sumber prompt yang dipakai bersama, bukan disalin manual dua kali — Antigravity boleh menentukan cara terbaik untuk ini, mis. taruh prompt di satu tempat yang bisa diakses baik dari `index.html` maupun Edge Function).

**Perbedaan perilaku WA vs Web** (satu-satunya yang beda, bukan logic parsingnya):
- **Web**: hasil parsing ditampilkan dulu di modal untuk direview/diedit, baru user tekan "Simpan" (lihat `saveAiScanSelected()`).
- **WA**: hasil parsing **langsung disimpan otomatis** ke Supabase per objek (tanpa modal review) — KECUALI objek yang `amount`-nya 0 (lihat bagian 5.1a), yang **ditahan dulu** sampai nominalnya dilengkapi.

## 5. FEATURE REQUIREMENTS

### 5.1 Pencatatan transaksi via teks bebas
- Terima berbagai variasi kalimat, memakai prompt & schema yang sama dengan Analisis Transaksi AI di web (lihat bagian 4a) — termasuk seluruh kemampuan mengenali slang/typo Indonesia, format nominal informal, dan aturan validasi transaksi yang sudah ada di situ.
- Kategori **WAJIB dicocokkan ke daftar kategori yang SUDAH ADA di Supabase** (persis seperti web) — Gemini tidak mengarang kategori baru.
- **Dompet tujuan**: default ke 1 dompet utama yang ditentukan pemilik produk, KECUALI pesan menyebut eksplisit nama dompet lain (mis. "dari tabungan bayar ...") — kalau disebut eksplisit, Gemini cocokkan ke daftar dompet yang ada dan pakai itu.
- **Pengenalan nominal berulang**: kalau nominal tidak disebutkan di pesan (mis. cuma "nasi kuning" atau "gaji masuk", sesuai perilaku `amount: 0` yang sudah ada di prompt), sistem WA (di luar apa yang sudah dilakukan prompt) mencari transaksi lampau dengan **keterangan yang mirip** dalam **kategori yang sama**, dan memakai nominal dari situ sebagai pelengkap. Kalau tidak ditemukan histori yang cocok, ikuti alur 5.1a (tahan & tanya).

### 5.1a Penanganan transaksi dengan nominal belum jelas (amount 0)
- Beda dari web (yang menyimpan baris amount 0 sebagai "masih pending" di dalam modal, bisa dilengkapi kapan saja), untuk WA: transaksi dengan `amount` 0 setelah dicoba dicocokkan ke histori (5.1) **TIDAK langsung disimpan ke Supabase**. Sistem menahan dulu datanya (state sementara, di luar tabel transactions), dan bot balas **menanyakan nominalnya** secara spesifik ke item itu.
- Begitu pemilik produk membalas dengan nominal (lewat reply ke bubble pertanyaan itu, atau pesan baru), baru transaksi itu benar-benar disimpan ke Supabase, dan bot balas konfirmasi normal (bagian 5.6).

### 5.2 Pencatatan transaksi via foto (BEBAS — bukan cuma struk, mendukung multi-foto)
- Terima 1 atau beberapa foto sekaligus (dengan atau tanpa caption) dari WhatsApp. **Foto TIDAK harus struk** — bisa struk, foto barang, atau foto apa pun yang relevan.
- **Batching multi-foto**: kalau pemilik produk kirim beberapa foto berurutan cepat, sistem **menunggu jeda singkat** (Antigravity menentukan durasi teknis yang wajar, mis. beberapa detik) untuk mengumpulkan semua foto yang masuk beruntun sebagai **satu batch**, baru diproses bareng dalam SATU panggilan Gemini — meniru persis perilaku multi-file upload di web (`aiCaptureFiles` + 1 `aiScanTextValue` untuk semua file, lihat `aiScanWithGemini()`).
- **Caption pada salah satu foto berlaku sebagai teks bebas untuk SELURUH batch**, bukan cuma untuk foto itu saja — karena WA tidak punya konsep "1 keterangan gabungan untuk banyak foto" seperti web, jadi caption apapun yang ada di foto manapun dalam batch itu diperlakukan sebagai isian `TEKS_BEBAS_DARI_USER` yang sama, mengikuti prompt yang sudah ada.
- Hasil dari satu batch bisa berupa beberapa objek transaksi (sudah otomatis dikelompokkan per kategori oleh logic yang sudah ada di prompt, lihat bagian 4a) — masing-masing objek diproses sesuai bagian 5.1a (kalau amount 0) atau langsung disimpan + dibalas per bagian 5.6/5.7.
- **Foto TIDAK disimpan permanen** di mana pun (lihat bagian 4).

### 5.2b Pencatatan transaksi via Pesan Suara (VN — baru)
- Terima pesan suara (voice note) WhatsApp — **dikirim LANGSUNG ke Gemini sebagai audio, TANPA tahap transkripsi teks terpisah**. Gemini yang sekaligus "mendengar" isi suara DAN mengekstrak transaksi dalam satu panggilan (audio understanding), memakai prompt & schema yang sama dengan bagian 4a (diperluas untuk menerima input audio, bukan cuma teks/gambar).
- Perlakukan VN setara dengan pesan teks bebas (bagian 5.1) dari sisi alur data — hasilnya tetap objek transaksi dengan field yang sama (tanggal, kategori, jenis, nominal, keterangan), lewat jalur amount-0-holding yang sama (bagian 5.1a) kalau nominal tidak jelas terdengar.
- **VN bisa digabung dalam batch dengan foto** kalau dikirim beruntun cepat (mengikuti prinsip batching di bagian 5.2), atau berdiri sendiri kalau dikirim terpisah.
- **⚠️ Catatan teknis penting (perlu diverifikasi Antigravity saat implementasi)**: WhatsApp mengirim voice note dalam format `audio/ogg` (codec Opus). Sebagian dokumentasi/laporan pengguna Gemini API menunjukkan endpoint tertentu (mis. Embedding API) menolak format OGG/Opus dan hanya menerima MP3/WAV, sementara endpoint audio understanding utama (generateContent/Interactions API) umumnya mendukung format lebih luas termasuk OGG — **tapi ini perlu dicoba langsung**, bukan diasumsikan. **Kalau ternyata `audio/ogg` ditolak API**, Antigravity WAJIB menambah 1 langkah konversi format audio (mis. OGG → WAV/MP3, pakai library konversi audio yang ringan di Edge Function) SEBELUM dikirim ke Gemini — bukan menambah tahap transkripsi teks terpisah (itu melanggar prinsip "tanpa transkrip" di atas). Konversi format ≠ transkripsi: audio tetap audio, cuma bentuk filenya yang disesuaikan supaya diterima API.
- **Audio TIDAK disimpan permanen** di mana pun — sama seperti foto (bagian 4), diambil dari Meta, diproses di memori (termasuk konversi format kalau perlu), dikirim ke Gemini, lalu dibuang.

### 5.3 Query saldo
- "Cek saldo" atau pertanyaan sejenis → bot balas **total saldo semua dompet dulu, lalu breakdown per dompet di bawahnya**.
- "Tabungan ada berapa" → *(lihat Open Questions, bagian 15 — perlu klarifikasi dompet/goal mana yang dimaksud "tabungan")*.

### 5.4 Respons untuk pesan ambigu/bukan transaksi
- Kalau pesan tidak jelas maksudnya sebagai transaksi atau query, **bot merespons pakai hasil AI yang natural** (bukan balasan template kaku) — mencoba pahami maksud, atau menanyakan balik dengan bahasa natural, mengikuti gaya bahasa santai yang sudah dipakai di aplikasi utama.
- Prompt yang sudah ada (bagian 4a) sudah punya aturan ketat kapan suatu teks dianggap BUKAN transaksi (sapaan murni, pertanyaan ke asisten, gibberish) — kasus ini yang dimaksud "ambigu" di sini, direspons dengan balasan AI natural, bukan disimpan sebagai transaksi kosong.

### 5.5 Perintah "hapus transaksi terakhir"
- Perintah eksplisit (mis. "hapus transaksi terakhir") untuk menghapus transaksi PALING BARU yang tercatat lewat WA (bukan lewat web/APK). Bot langsung hapus + balas konfirmasi berisi detail transaksi yang dihapus.
- **Catatan**: dengan adanya fitur reply-to-edit/delete (bagian 5.7) yang lebih presisi, perintah ini jadi pelengkap untuk kasus pemilik produk sudah tidak melihat/menemukan bubble transaksi yang mau dihapus.

### 5.6 Balasan konfirmasi setelah transaksi tercatat
- **Satu bubble balasan WA = satu OBJEK transaksi hasil akhir dari Gemini** (yang sudah melalui proses grouping-per-kategori dari prompt yang ada — lihat bagian 4a). Kalau 1 pesan/batch foto menghasilkan 3 objek transaksi (misal kategori Makan, Belanja, Transportasi), bot mengirim **3 pesan WA terpisah**, masing-masing 1 bubble per transaksi.
- Format contoh tiap bubble (menyesuaikan gaya bahasa aplikasi utama), dengan **baris kosong sebagai pemisah antar kelompok field** supaya rapi dibaca di WhatsApp:
```
✓ Transaksi tercatat
Tanggal : 12 Agustus 2026

Pengeluaran: Rp35.000
Kategori: Makanan
Keterangan: Makan siang

Dompet: Dompet Utama
Sisa dompet: Rp465.000
```
- **Struktur bubble = 3 kelompok, dipisah baris kosong**: (1) judul + Tanggal, (2) Jenis+Nominal, Kategori, Keterangan, (3) Dompet, Sisa dompet. Ini bukan cuma daftar rata field, tapi berpadding/berkelompok seperti contoh di atas.
- Field **Keterangan** hanya ditampilkan kalau memang terisi (tidak kosong) — kalau kosong, baris itu dilewati saja (bukan ditampilkan sebagai "Keterangan: -").
- Format tanggal mengikuti gaya yang sudah dipakai di aplikasi utama (bahasa Indonesia, mis. "12 Agustus 2026") — Antigravity WAJIB samakan persis dengan format tanggal yang sudah ada di `index.html`, bukan membuat format baru.
- Message ID dari tiap bubble yang dikirim bot **WAJIB disimpan** (dipetakan ke transaction ID terkait di Supabase) — ini fondasi untuk fitur reply-to-edit/delete di bagian 5.7.

### 5.7 Reply-to-edit/delete lewat bubble chat (fitur baru)

**Konsep**: pemilik produk bisa membalas (reply/quote) langsung ke salah satu bubble konfirmasi transaksi (bagian 5.6) dengan teks bebas — sistem tahu persis transaksi mana yang dimaksud (dari bubble mana yang di-reply), lalu menerapkan koreksi ke transaksi itu SAJA, tidak mempengaruhi transaksi lain.

**Cara kerja teknis**: WhatsApp Cloud API menyertakan field `context.id` di payload webhook setiap kali pesan masuk adalah balasan (reply) ke pesan tertentu — ini berisi message ID dari pesan yang di-reply. Karena bot menyimpan mapping `wa_message_id → transaction_id` saat mengirim tiap bubble konfirmasi (bagian 5.6), begitu ada reply masuk dengan `context.id` yang cocok, sistem tahu persis transaksi Supabase mana yang dimaksud.

**Perilaku:**
- Reply berupa teks bebas (mis. "500rb", "kategorinya transport", "hapus", "dompetnya dari tabungan aja", "keterangannya ganti jadi bensin motor") — **Gemini yang menafsirkan** teks itu sebagai instruksi koreksi, dengan konteks data transaksi yang sedang direply (dikirim juga ke Gemini sebagai referensi), lalu menghasilkan instruksi update (field mana yang berubah, nilai barunya) atau instruksi hapus.
- **Field yang boleh diedit lewat reply**: nominal, kategori, keterangan, dan dompet — fleksibel, tidak harus semua field disebut sekaligus (reply "500rb" saja cukup untuk ganti nominal doang, field lain tidak berubah).
- Reply yang jelas maksudnya "hapus" (mis. "hapus", "batalkan", "salah kirim") → transaksi terkait dihapus dari Supabase, bot balas konfirmasi penghapusan (masih dalam thread reply yang sama).
- Setelah edit berhasil, bot balas konfirmasi berisi data transaksi yang sudah diperbarui (format serupa bagian 5.6, ditandai sebagai "sudah diperbarui").
- Kalau reply tidak jelas maksud koreksinya (Gemini tidak yakin), bot balas minta klarifikasi, TIDAK mengubah data secara sembarangan.

## 6. DATA MODEL (perubahan/tambahan dari PRD utama)

- Tabel `transactions` di Supabase (yang sudah ada dari Fase 1) mendapat **kolom baru**: `source` (nilai: `"whatsapp"` untuk transaksi dari fitur ini, `"app"` atau kosong untuk transaksi dari web/APK seperti biasa).
- **Tabel/mapping baru**: `wa_message_transactions` — menyimpan pasangan `wa_message_id` (message ID dari bubble konfirmasi yang dikirim bot) ↔ `transaction_id` (baris di tabel `transactions`), dipakai untuk fitur reply-to-edit/delete (bagian 5.7). Perlu juga tempat penyimpanan sementara (bisa tabel terpisah atau kolom status) untuk transaksi yang masih "menunggu nominal" (bagian 5.1a) sebelum resmi masuk tabel `transactions`.
- Tidak ada tabel foto/media — sesuai bagian 4, foto tidak disimpan.
- Kategori dan dompet **dibaca dari tabel yang sudah ada** (dari Fase 1) — TIDAK ada tabel kategori/dompet terpisah khusus WA.

## 7. SECURITY

- **Secret yang TIDAK BOLEH pernah muncul di frontend/kode yang ter-commit ke GitHub**: WhatsApp Access Token, App Secret, Gemini API Key, Supabase Service Role Key.
- Semua secret di atas disimpan sebagai **environment variable / secret di konfigurasi Supabase Edge Function** (pemilik produk sudah punya semuanya siap di file `.env` pribadi — App ID, App Secret, Phone Number ID, Access Token permanent, Verify Token), diakses cuma dari sisi backend.
- Supabase Anon/Publishable Key boleh tetap di frontend seperti biasa, SELAMA Row Level Security (RLS) sudah dikonfigurasi (mengikuti bagian 20 di PRD utama).
- Webhook harus verifikasi keaslian request dari Meta pakai **Verify Token** saat setup webhook (`catatankeuangan2026verify`, sudah dibuat pemilik produk), dan idealnya validasi signature `X-Hub-Signature-256` dari Meta (pakai App Secret) — supaya tidak sembarang orang bisa "pura-pura" jadi Meta dan kirim data palsu ke webhook.
- Karena nomor WA yang dipakai adalah nomor pribadi asli pemilik produk (bukan nomor test terbatas recipient), **pastikan webhook memvalidasi bahwa pesan masuk benar dari nomor pemilik produk sendiri** (cocokkan nomor pengirim di payload) sebelum diproses — mencegah orang lain yang entah bagaimana tahu nomor Business ini ikut mengirim pesan yang diproses sebagai transaksi.

## 8. ERROR HANDLING

- Kalau Gemini API gagal/timeout: bot balas pesan wajar ("maaf, lagi ada gangguan baca pesannya, coba lagi ya") — bukan diam saja atau crash. Boleh reuse pola retry (`MAX_ATTEMPTS`) yang sudah ada di `aiScanWithGemini()`.
- Kalau kategori/dompet yang disebut user tidak ditemukan di data yang ada: fallback ke default (kategori "Lainnya", dompet default), sambil tetap beri tahu di balasan bahwa itu dipakai sebagai fallback.
- Kalau webhook menerima event yang bukan dari nomor pemilik produk: abaikan, jangan diproses (lihat bagian 7).
- Kalau reply masuk dengan `context.id` yang tidak ditemukan di mapping `wa_message_transactions` (mis. reply ke pesan sangat lama yang sudah tidak ada, atau reply ke pesan yang bukan bubble transaksi): bot balas bahwa transaksi terkait tidak ditemukan, tidak melakukan apa-apa ke data.

## 9. TESTING REQUIREMENTS

- Uji semua variasi contoh pesan teks di bagian 5.1, pastikan hasil parsingnya konsisten dengan hasil di web untuk input yang sama (karena reuse prompt & schema yang sama, bagian 4a).
- Uji kirim 1 foto dan multi-foto sekaligus (struk & non-struk), dengan caption di foto pertama/tengah/terakhir dalam batch, pastikan caption berlaku untuk seluruh batch.
- **Uji kirim pesan suara (VN)** dengan berbagai variasi ucapan (setara variasi teks di bagian 5.1), pastikan diproses langsung sebagai audio (bukan lewat transkripsi teks terpisah) dan hasilnya akurat. **Uji juga apakah format `audio/ogg` dari WhatsApp diterima langsung oleh Gemini API atau perlu dikonversi dulu** (lihat catatan teknis di bagian 5.2b) — dokumentasikan hasil temuannya.
- Uji transaksi dengan amount 0 (bagian 5.1a): pastikan TIDAK langsung masuk tabel transactions, bot menanyakan nominal, dan setelah dijawab baru tersimpan.
- Uji penyebutan dompet eksplisit vs default.
- Uji "cek saldo" dan pastikan format balasan sesuai.
- Uji "hapus transaksi terakhir".
- Uji **reply-to-edit** ke bubble tertentu: ubah nominal saja, ubah kategori saja, ubah beberapa field sekaligus, dan pastikan transaksi LAIN (di bubble lain) tidak ikut berubah.
- Uji **reply-to-delete** ke bubble tertentu, pastikan hanya transaksi itu yang terhapus.
- Uji multi-transaksi dalam 1 batch (mis. struk dengan 3 kategori) menghasilkan 3 bubble balasan terpisah, masing-masing bisa di-reply independen.
- Uji pesan ambigu/obrolan biasa, pastikan respons AI terasa natural bukan template, dan TIDAK membuat transaksi kosong.
- Uji bahwa data yang masuk lewat WA (termasuk hasil edit/delete via reply) benar-benar tercermin di web/APK aplikasi utama setelah sinkron.
- Uji bahwa foto TIDAK tersimpan di Supabase Storage atau tempat lain manapun setelah proses selesai.

## 10. PRE-FLIGHT CHECKLIST (WAJIB dijalankan Antigravity sebelum mulai)

Sama seperti prinsip di PRD utama (bagian 29a) — Antigravity WAJIB:
1. Minta pemilik produk menempelkan langsung dari file `.env` pribadinya (bukan menebak/mengarang): **Phone Number ID** (`1167362029803274`), **WhatsApp Access Token** (permanent), **App ID** (`1965068081116241`), **App Secret**, **Verify Token** (`catatankeuangan2026verify`), dan konfirmasi **Gemini API Key** yang direuse dari aplikasi utama (TIDAK bikin baru).
2. Konfirmasi ke pemilik produk: nama dompet default untuk transaksi WA, sebelum hardcode di manapun.
3. **WAJIB baca & pahami prompt Gemini yang sudah ada di `index.html`** (fungsi `aiScanWithGemini`) sebelum menulis kode Edge Function — reuse persis, bukan menulis ulang dari ingatan/asumsi (lihat bagian 4a).
4. Sebelum deploy Edge Function pertama kali dan sebelum daftarkan Callback URL + Verify Token ke Meta (bagian "Configure Webhooks" yang sudah pemilik produk siapkan tapi belum diisi), **konfirmasi dulu ke pemilik produk**.
5. Setelah webhook aktif, **WAJIB uji coba kirim 1 pesan test dulu** dan tunjukkan hasilnya ke pemilik produk sebelum dianggap selesai.

## 11. IMPLEMENTATION PHASES (usulan)

1. **Fase 7.1 — Setup Meta (SUDAH SELESAI oleh pemilik produk)**: nomor pribadi 081226964679 sudah teregistrasi sebagai nomor WhatsApp Business, seluruh kredensial (Phone Number ID, Access Token, App ID, App Secret, Verify Token) sudah terkumpul di `.env` pribadi pemilik produk.
2. **Fase 7.2 — Webhook & Data Layer**: *(checkpoint: kredensial dari Fase 7.1 sudah lengkap)* buat Supabase Edge Function, daftarkan webhook ke Meta (isi Callback URL + Verify Token di halaman "Configure Webhooks"), tambah kolom `source` di tabel transactions, buat tabel/mapping `wa_message_transactions` dan tempat penyimpanan sementara untuk transaksi amount-0 (bagian 6).
3. **Fase 7.3 — Reuse Parsing Teks, Foto & Audio**: pindahkan/reuse prompt & schema dari `aiScanWithGemini()` (bagian 4a) ke Edge Function, perluas untuk menerima input audio (bagian 5.2b — termasuk verifikasi/penanganan format OGG/Opus), implementasi batching multi-foto + caption gabungan (bagian 5.2), logika dompet default/eksplisit dan pengenalan nominal berulang (bagian 5.1), alur tahan-transaksi-amount-0 (bagian 5.1a).
4. **Fase 7.4 — Balasan Per-Transaksi & Mapping**: implementasi kirim 1 bubble WA per objek transaksi (bagian 5.6), simpan mapping `wa_message_id ↔ transaction_id`.
5. **Fase 7.5 — Reply-to-Edit/Delete**: implementasi baca `context.id` dari webhook, lookup mapping, kirim ke Gemini untuk tafsir instruksi koreksi, update/hapus transaksi terkait (bagian 5.7).
6. **Fase 7.6 — Query & Perintah Khusus**: cek saldo, hapus transaksi terakhir, respons AI untuk pesan ambigu.
7. **Fase 7.7 — Pengujian Menyeluruh**: jalankan semua skenario di bagian 9, pastikan data tersinkron ke aplikasi utama.

## 12. ACCEPTANCE CRITERIA

- [ ] Pesan teks berbagai variasi berhasil tercatat sebagai transaksi yang benar di Supabase, hasilnya konsisten dengan logic yang sama di web.
- [ ] Multi-foto dalam satu batch diproses bareng, caption di foto manapun dalam batch berlaku untuk seluruh batch.
- [ ] Pesan suara (VN) berhasil diproses langsung sebagai audio oleh Gemini (tanpa tahap transkripsi teks terpisah) dan menghasilkan transaksi yang akurat, dengan audio TIDAK tersimpan permanen di mana pun.
- [ ] Foto berhasil dibaca dan tercatat — baik foto struk maupun foto bebas non-struk — TANPA foto tersimpan permanen di mana pun.
- [ ] Transaksi dengan nominal tidak terdeteksi (amount 0) TIDAK langsung tersimpan; bot tanya nominal dulu; setelah dijawab baru tersimpan.
- [ ] Dompet default terpakai otomatis, dompet eksplisit terdeteksi dengan benar saat disebut.
- [ ] "Cek saldo" membalas total + breakdown per dompet.
- [ ] "Hapus transaksi terakhir" berfungsi.
- [ ] Satu batch yang menghasilkan beberapa transaksi (beda kategori) menghasilkan bubble balasan terpisah per transaksi.
- [ ] Reply ke bubble tertentu berhasil mengedit HANYA transaksi itu (nominal/kategori/keterangan/dompet, fleksibel salah satu atau gabungan), transaksi lain tidak terpengaruh.
- [ ] Reply "hapus"/sejenisnya ke bubble tertentu berhasil menghapus HANYA transaksi itu.
- [ ] Pesan ambigu direspons dengan hasil AI natural, bukan template kaku, dan tidak membuat transaksi kosong.
- [ ] Semua secret (App Secret, WA token, Gemini key, Supabase service key) tidak ada satupun yang ter-expose di frontend/kode publik.
- [ ] Data transaksi dari WA (termasuk hasil edit/delete) langsung terlihat di web & APK aplikasi utama setelah sinkron.
- [ ] Tidak ada biaya berbayar.

## 13. DEFINITION OF DONE

Sama seperti prinsip di PRD utama (bagian 28) — fase ini selesai kalau semua Acceptance Criteria terpenuhi, sudah diuji fungsional sungguhan (bukan cuma "kelihatannya jalan"), dan tidak merusak fitur aplikasi utama yang sudah ada.

## 14. RISKS

- **Kualitas parsing AI tidak 100% sempurna** — pesan yang sangat ambigu bisa salah kategori/nominal; mitigasi lewat balasan konfirmasi per-transaksi (bagian 5.6) dan fitur reply-to-edit (bagian 5.7) sebagai jalan koreksi cepat dan presisi.
- **Ketergantungan pada layanan Meta** — kalau Meta ubah kebijakan/format webhook di masa depan, integrasi ini perlu disesuaikan (di luar kendali proyek ini).
- **Kuota gratis Supabase Edge Function & Gemini API** tetap terbagi dengan pemakaian aplikasi utama — perlu dipantau kalau pemakaian bertambah signifikan.
- **Duplikasi/divergensi prompt Gemini** — karena prompt yang sama dipakai di 2 tempat (web & Edge Function WA), ada risiko keduanya "kelupaan" disinkronkan kalau salah satu diupdate di masa depan (lihat mitigasi arsitektur di bagian 4a).
- **2FA akun Meta pemilik produk sempat tertahan** ("device belum dikenal") — tidak menghalangi progres (sudah diselesaikan lewat jalur System User), tapi disarankan tetap diaktifkan lain waktu untuk keamanan akun jangka panjang.
- **Kompatibilitas format audio VN** — WhatsApp mengirim voice note dalam format OGG/Opus; belum dipastikan apakah Gemini API menerima format ini secara langsung atau butuh konversi dulu (lihat bagian 5.2b). Ini bisa menambah kompleksitas teknis kecil (langkah konversi format) kalau ternyata dibutuhkan — bukan risiko besar, tapi perlu dicek di awal implementasi Fase 7.3, bukan diasumsikan lancar.

## 15. OPEN QUESTIONS

- **"Tabungan ada berapa"** — belum jelas ini merujuk ke dompet bernama "Tabungan" tertentu, atau ke fitur Tujuan Tabungan (savings goal) dari Fase sebelumnya. Perlu dikonfirmasi ke pemilik produk sebelum Fase 7.6 dikerjakan.
- Nama dompet default untuk transaksi WA belum ditentukan eksplisit — perlu dikonfirmasi di Fase 7.2.
- Durasi jeda batching multi-foto (bagian 5.2) belum ditentukan angka pastinya — didelegasikan ke Antigravity untuk menentukan nilai teknis yang wajar (mis. beberapa detik), boleh disesuaikan berdasarkan pengujian nyata.

## 16. ANTIGRAVITY IMPLEMENTATION INSTRUCTIONS (tambahan khusus fase ini)

Selain instruksi umum di PRD utama (bagian 34), khusus fase ini:
1. **JANGAN PERNAH** menulis kode yang menyimpan file gambar/foto ke Supabase Storage atau disk manapun — proses harus selesai di memori.
2. **JANGAN** membuat Google Cloud Project baru untuk Gemini — reuse API key yang sudah ada.
3. **WAJIB reuse prompt & schema Gemini yang sudah ada di `aiScanWithGemini()`** (bagian 4a) — jangan menulis prompt baru dari asumsi/ingatan sendiri, baca dulu kode aslinya.
4. Pastikan semua balasan bot berbahasa Indonesia, gaya santai, konsisten dengan tone aplikasi utama.
5. Fitur reply-to-edit/delete (bagian 5.7) HARUS presisi per-transaksi — kalau ada keraguan teknis soal `context.id` tidak match atau ambigu, JANGAN mengubah data sembarangan, tanyakan/tolak dengan aman.

---

## 17. LAMPIRAN — Keputusan & Kredensial Setup Meta yang Sudah Diambil

- Pemilik produk sudah punya: Meta Developer Account, Meta App "Catatan Keuangan" (App ID `1965068081116241`), Business Portfolio "Catatan Keuangan".
- **Nomor pribadi 081226964679 BERHASIL diregistrasi langsung sebagai nomor WhatsApp Business** (Phone Number ID `1167362029803274`, status "Registered") — bukan memakai nomor test Meta seperti rencana di versi 1.0 dokumen ini. Pemilik produk chat ke nomor Business ini dari WhatsApp pribadinya (yang sudah sama dengan nomor Business-nya sendiri).
- Access Token **permanent** sudah berhasil digenerate lewat jalur **System User** (Business Settings > System Users), karena jalur token langsung di halaman utama sempat tertahan verifikasi 2FA ("device belum dikenal") — permission yang dicentang: `whatsapp_business_management` dan `whatsapp_business_messaging`.
- Verify Token yang dibuat pemilik produk: `catatankeuangan2026verify` — BELUM diisi ke kolom "Configure Webhooks" di Meta, sengaja ditahan sampai Callback URL dari Antigravity tersedia (lihat Fase 7.2).
- Seluruh kredensial (Phone Number ID, Access Token, App ID, App Secret, Verify Token) sudah dikumpulkan pemilik produk di file `.env` pribadi, siap diserahkan ke Antigravity.
