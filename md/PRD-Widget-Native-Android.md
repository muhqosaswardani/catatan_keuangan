# PRD — Widget Native Android untuk "Tambah via AI" (KaslyAI)

**Status:** Draft
**Project terkait:** [[aplikasi-keuangan]] (KaslyAI)
**Lokasi kerja lokal (PWA existing):** `D:\04. QOSAS\PYTHON\CATATAN KEUANGAN\app`
**Lokasi project Android Studio (app native baru):** `D:\AndroidStudioProjects\KaslyAI`
**Prinsip utama:** ini adalah PENAMBAHAN murni. Tidak ada satu pun file/folder existing di path di atas yang diubah atau dihapus sebagai bagian dari fase ini kecuali disebut eksplisit di bagian "Yang Disentuh" di bawah.

---

## 1. Latar Belakang

Dari pembacaan langsung `index.html` di repo `muhqosaswardani/catatan_keuangan`, perilaku "Tambah via AI" saat ini di PWA adalah:

- Tombol FAB (`fabPressStart` → `fabPressMove` → `fabPressEnd`) mendeteksi **gesture drag**, bukan long-press klasik:
  - Drag ke **atas** sampai jarak ambang (`FAB_DRAG_THRESHOLD`) → `openAiScanModal()` — ini yang selama ini disebut "fitur AI" (foto/PDF/teks bebas/rekam suara, dianalisis lewat `aiScanWithGemini()`, bisa juga dipakai untuk obrolan umum karena promptnya punya kategori `general_chat`).
  - Drag ke **kiri** sampai ambang → `chooseAddTransaction()` — form tambah transaksi manual (bukan AI).
  - Tap biasa (tanpa drag) → `openAddChoice()` — modal pilihan (AI, Transaksi, Transfer, Transaksi Cepat/shortcut).
- Di dalam modal `modalAiScan`, ada 3 jalur input yang semuanya masuk ke fungsi analisis Gemini yang sama:
  - Teks bebas (`aiScanTextValue`, lewat `onAiTextInput`)
  - Foto/PDF (`aiCaptureFiles`, lewat `onAiFilesAdded`)
  - Rekam suara (`toggleAiVoiceRecording` → `MediaRecorder` → `aiVoiceAudioPart`, begitu rekaman berhenti **langsung** terkirim ke Gemini tanpa perlu klik tombol lagi)
- Ketiganya bermuara ke satu fungsi: `aiScanWithGemini(key)`.

Jadi yang sebelumnya disebut user sebagai "fitur chat dan transaksi cepat AI yang harus lewat long-press" sebenarnya **satu fitur yang sama** (`Tambah via AI` / `aiScanWithGemini`) dengan dua cara masuk cepat: **mic** (drag-up lalu tap mic, atau langsung rekam) dan **foto** (drag-up lalu ambil foto). Ini penting karena artinya widget tidak perlu mereplikasi dua sistem berbeda — cukup **satu pipeline AI** dengan dua tombol pemicu (mic & foto).

## 2. Tujuan

Membuat **aplikasi Android native** (bukan lagi PWA murni) yang tujuan utamanya adalah menyediakan **App Widget** di homescreen dengan 2 tombol:

1. **Tombol Mic** — tekan, langsung bisa bicara, hasil (transaksi tercatat) tanpa perlu membuka aplikasi utama sama sekali.
2. **Tombol Foto** — tekan, kamera muncul sebentar untuk ambil foto, hasil diproses & disimpan tanpa membuka aplikasi utama.

Kedua tombol ini harus **identik 100%** secara logika bisnis dengan `Tambah via AI` yang sudah ada di PWA — prompt Gemini yang sama, aturan parsing yang sama (termasuk `SLANG_NOMINAL_MAP`, deteksi `general_chat`, dsb), skema transaksi yang sama, dan tersimpan ke backend Supabase yang sama.

## 3. Yang Disentuh vs Yang Tidak

**Tidak disentuh sama sekali:**
- `index.html` dan seluruh logika PWA yang sudah ada (kecuali penambahan kecil murni untuk kompatibilitas, dijelaskan di bagian 5).
- Struktur Supabase, schema.sql, Edge Functions yang sudah ada.
- Alur WhatsApp integration yang sedang berjalan.

**Ditambahkan (baru, folder terpisah):**
- Project Android native baru (Kotlin), berada di `D:\AndroidStudioProjects\KaslyAI` — folder Android Studio sendiri, sama sekali terpisah dari folder PWA di atas, tidak menimpa apa pun yang sudah ada.
- App Widget (Glance atau RemoteViews) dengan 2 tombol.
- Komponen native pendukung: trampoline activity transparan, foreground service untuk proses background, notifikasi hasil.

## 4. Keputusan Arsitektur Kunci

### 4.1 Kenapa harus native, bukan PWA
Seperti dibahas sebelumnya di percakapan ini: App Widget adalah API level OS Android (`RemoteViews`/`Glance`), sama sekali tidak bisa diakses dari konteks PWA/WebView biasa. Maka aplikasi ini **wajib** dibungkus sebagai APK native Android.

### 4.2 Kenapa TIDAK menulis ulang logika AI dari nol
Requirement eksplisit: "identik 100%". Menulis ulang prompt Gemini, aturan parsing nominal, deteksi kategori, dsb dalam Kotlin akan menciptakan **dua sumber kebenaran** yang gampang drift setiap kali `index.html` diupdate (dan project ini sering di-update, terlihat dari riwayat versi v2.9 → v3.5.5).

**Keputusan: gunakan pendekatan "headless WebView".**

Aplikasi native menjalankan `WebView` yang me-load `index.html` yang **sama persis** dengan yang dipakai PWA (bisa dari URL hosting yang sama, atau dibundel offline di dalam APK), tapi WebView ini:
- Tidak pernah ditampilkan ke layar (attached ke Window tapi invisible, atau dijalankan di dalam Service dengan ukuran 0x0/off-screen).
- Dipicu dari widget untuk langsung memanggil fungsi JavaScript yang sudah ada (`aiScanWithGemini`, dsb) lewat `evaluateJavascript()`.
- Hasil analisis dikembalikan ke sisi native lewat `JavascriptInterface` (jembatan JS ↔ Kotlin).

Konsekuensi: kode AI di `index.html` **tidak perlu diduplikasi**. Kalau nanti prompt Gemini diubah di web, widget otomatis ikut berubah tanpa perlu update APK (jika di-load dari URL, bukan dibundel).

**Trade-off yang perlu disetujui user:** headless WebView tetap butuh render engine jalan di background sesaat (untuk load DOM & jalankan JS), jadi ada delay singkat (biasanya di bawah 1 detik untuk load, ditambah waktu request ke Gemini yang sama seperti di web) sebelum hasil muncul. Ini lebih lambat dibanding native murni, tapi jauh lebih aman untuk konsistensi 100% dan lebih cepat dikembangkan.

### 4.3 Alternatif yang ditolak (dicatat untuk referensi)
- **Port penuh ke Kotlin** (panggil Gemini API langsung dari native): lebih cepat & lebih "native-feel", tapi melanggar syarat "identik 100%" kecuali logic-nya benar-benar disalin ulang manual dan dijaga sinkron — risiko maintenance tinggi, ditolak untuk fase ini.
- **WebView visible di dalam widget**: tidak mungkin — App Widget tidak mendukung WebView sama sekali (RemoteViews hanya mendukung subset view tertentu).

## 5. Spesifikasi Perilaku Widget

### 5.1 Tampilan widget
- Ukuran: lebar (mengikuti App Widget grid, minimal 4x1 cell / setara ±250dp x 60-70dp), menampilkan 2 tombol besar bersebelahan: ikon mic di kiri, ikon kamera di kanan. Style mengikuti preferensi UI existing (modern, minim warna, ikon SVG/vector, tanpa emoji — konsisten dengan [[aplikasi-keuangan]]).

### 5.2 Tombol Mic ditekan
1. Widget memicu `PendingIntent` → trampoline `Activity` bertema transparan (`Theme.Translucent.NoTitleBar`, tanpa animasi masuk).
2. Trampoline langsung menampilkan **overlay kecil** (mirip mic Google Assistant) di atas homescreen — indikator "sedang mendengarkan" + tombol stop.
3. Native merekam audio (`MediaRecorder`, format yang didukung Gemini — sama seperti `aiMicRecorder` di web menggunakan `audio/webm` dsb).
4. Setelah user selesai bicara (tap stop, atau auto-stop dari jeda diam — didetailkan nanti), file audio di-base64-kan dan dikirim ke instance WebView headless untuk diproses lewat pipeline `aiScanWithGemini` yang sama persis (audio diperlakukan sebagai voice-note, sama seperti alur WA).
5. Overlay tertutup otomatis begitu proses mulai (tidak menunggu di layar).
6. Hasil (transaksi tersimpan / butuh klarifikasi / gagal) ditampilkan lewat **notifikasi** — memakai infrastruktur push notification (Web Push/VAPID) yang sudah dibangun di Fase 2 Bagian 1, atau notifikasi native lokal kalau lebih sederhana untuk kasus ini (perlu diputuskan — lihat Open Question 8.3).

### 5.3 Tombol Foto ditekan
1. Widget memicu trampoline `Activity` transparan yang langsung membuka **kamera sistem** (via `Intent(MediaStore.ACTION_IMAGE_CAPTURE)` atau CameraX minimal-UI) — bukan membuka aplikasi utama.
2. User ambil foto (struk/nota/apa saja, sama seperti alur "foto bebas, tidak harus struk" yang sudah berlaku di WA).
3. Begitu foto diambil, activity langsung ditutup (tanpa preview konfirmasi tambahan — konsisten dengan "cepat, tanpa masuk app").
4. Foto dikirim ke WebView headless, diproses lewat `aiScanWithGemini` yang sama.
5. Hasil ditampilkan lewat notifikasi, sama seperti alur mic.

### 5.4 Konsistensi hasil dengan PWA
- Dompet tujuan: pakai default yang sama seperti di web (`primaryAiWallet` — dompet dengan `isPrimary`), karena widget tidak punya UI untuk memilih dompet di tempat.
- Kategori "Lainnya" tidak di-auto-isi kalau AI tidak yakin — ini sudah jadi salah satu item bug-fix yang sedang dikerjakan di PWA/WA; widget otomatis ikut aturan yang sama karena logic-nya dipakai bersama.
- Transaksi tersimpan ke Supabase lewat jalur yang sama seperti web (bukan jalur terpisah) — sinkron otomatis muncul juga di web & WA begitu user buka nanti.

## 6. Permission Android yang Dibutuhkan

| Permission | Kegunaan |
|---|---|
| `RECORD_AUDIO` | Rekam suara dari tombol mic |
| `CAMERA` | Ambil foto dari tombol kamera |
| `POST_NOTIFICATIONS` (Android 13+) | Tampilkan hasil lewat notifikasi |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MICROPHONE` / `...DATA_SYNC` | Proses rekam & kirim ke Gemini berjalan aman walau layar overlay ditutup |
| `INTERNET` | Panggil Gemini API & Supabase |
| (Opsional) `SYSTEM_ALERT_WINDOW` | Hanya kalau overlay mic dibuat sebagai window terpisah, bukan lewat trampoline Activity — lihat Open Question 8.1 |

## 7. Rencana Fase Pengerjaan

1. **Fase A — Pembungkus Native Dasar**: buat project Android baru, WebView utama menampilkan `index.html` persis seperti PWA (app "biasa" dulu, belum ada widget). Ini jadi fondasi & sekaligus APK yang bisa langsung dipakai sebagai pengganti PWA kalau perlu.
2. **Fase B — Jembatan JS Headless**: bangun `JavascriptInterface` yang bisa memanggil `aiScanWithGemini` secara terprogram dari native (tanpa lewat UI modal), dan menerima hasilnya. Diuji dulu dari dalam app (misal tombol debug), belum lewat widget.
3. **Fase C — Widget + Trampoline Mic**: bangun App Widget dua tombol, trampoline activity untuk mic, sambungkan ke Fase B, hasil tampil di notifikasi.
4. **Fase D — Trampoline Foto**: sama seperti C tapi untuk jalur kamera.
5. **Fase E — Polish**: styling widget final, penanganan izin ditolak, penanganan gagal jaringan, indikator loading di overlay.

## 8. Open Questions (perlu diputuskan sebelum/selama development)

1. **Overlay mic**: pakai trampoline Activity transparan (lebih aman, tidak butuh `SYSTEM_ALERT_WINDOW`) atau overlay window sungguhan (lebih mulus secara visual tapi butuh izin overlay yang harus di-approve manual oleh user di Settings)?
2. **Audio HTML bundel vs hosting**: `index.html` di-load dari URL (selalu versi terbaru, tapi butuh internet setiap kali widget dipakai) atau dibundel offline ke APK (bisa jalan tanpa internet untuk load awal, tapi perlu mekanisme update APK setiap `index.html` berubah)? Rekomendasi awal: dari URL, karena project ini sering di-update dan tujuan "identik 100%" akan lebih terjamin.
3. **Notifikasi hasil**: pakai infrastruktur Web Push (VAPID) yang sudah ada, atau notifikasi native lokal (lebih sederhana, tidak perlu round-trip ke server push)? Karena proses terjadi di HP yang sama, notifikasi native lokal kemungkinan lebih sesuai & lebih cepat — tapi perlu dipastikan tidak bentrok dengan sistem notifikasi WA yang sudah direncanakan di Fase 2 Bagian 2/3.
4. **Auto-stop rekaman mic**: berhenti otomatis setelah jeda diam sekian detik, atau murni manual (tap lagi buat stop, sama seperti kebiasaan tombol mic di web)?
5. **Nama & ikon APK**: apakah APK ini menggantikan konsep "PWA yang di-install ke homescreen" sepenuhnya, atau berjalan berdampingan (PWA tetap ada untuk yang tidak mau install APK, APK native khusus untuk yang mau fitur widget)?

## 9. Kriteria Selesai (Definition of Done)

- Widget bisa ditambahkan ke homescreen Android dari tray widget seperti widget lain pada umumnya.
- Tekan tombol mic → bicara → transaksi tercatat di Supabase (terlihat juga saat buka web/app) → notifikasi muncul — semua tanpa layar utama aplikasi pernah terbuka.
- Tekan tombol foto → foto struk apapun → transaksi tercatat sama seperti di atas.
- Hasil analisis (nominal, kategori, dompet) identik dengan hasil yang didapat kalau langkah yang sama dilakukan manual lewat drag-up FAB di PWA, dengan input yang sama persis.
- Tidak ada file di `D:\04. QOSAS\PYTHON\CATATAN KEUANGAN\app` (folder existing PWA) yang berubah kecuali disepakati eksplisit.
