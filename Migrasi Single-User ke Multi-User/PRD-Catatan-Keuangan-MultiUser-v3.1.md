# PRD — KaslyAI (Migrasi Single-User ke Multi-User)

**Versi:** 3.1 (Tambah fitur Hapus Akun di Dashboard Admin)
**Status Eksekusi:** ✅ Fase 1 (Pendaftaran, Verifikasi WA & Onboarding) sudah dijalankan/di-run di Antigravity IDE.
**Status:** Untuk direview

---

## 1. Latar Belakang

Aplikasi **KaslyAI** saat ini berjalan sebagai aplikasi individu (single-user), dengan data tersimpan tanpa pemisahan kepemilikan yang jelas — hanya dikunci dengan satu kode akses bersama. Aplikasi akan dikembangkan menjadi produk yang bisa didistribusikan dan dipakai banyak orang sekaligus (multi-user), berbasis PWA (bisa diinstal seperti aplikasi biasa), dengan tambahan fitur AI (analisis transaksi) dan integrasi WhatsApp.

Dua prototipe tampilan sudah dibuat dan jadi acuan utama dokumen ini:
- **prototype-flow.html** — alur pendaftaran & onboarding user, akan digabungkan langsung ke index utama aplikasi yang sudah ada.
- **admin-dashboard.html** — dashboard admin, jadi acuan awal sebelum disesuaikan lagi ke skema hosting & keamanan final (lihat bagian 3).

## 1b. Rebranding: Penulisan Nama "KaslyAI"

- Nama aplikasi/brand di seluruh dokumen, kode, dan tampilan **wajib ditulis "KaslyAI"** — satu kata, tanpa spasi, dengan kapitalisasi persis seperti itu (bukan "Kasly AI", bukan "kaslyai", bukan "Catatan Keuangan").
- **Styling visual** (dipakai di judul/logo, misal di layar promo pertama aplikasi): kata **"Kasly"** ditulis dengan warna font **hitam**, dan **"AI"** ditulis dengan warna font **hijau** — mengikuti contoh yang sudah ada di prototipe (judul di halaman pertama/hero).
- Semua penyebutan "Catatan Keuangan" sebagai nama produk di dokumen ini sudah diganti jadi "KaslyAI". Nama file/repo teknis lama (misal `catatan_keuangan` di GitHub) tidak wajib ikut berubah kalau tidak diminta, tapi tampilan yang dilihat user (judul, brand di layar, dashboard admin, halaman promosi) semua pakai "KaslyAI".

## 2. Tujuan

- Setiap pengguna punya akun dan data masing-masing yang aman dan terpisah dari pengguna lain.
- Ada cara terkendali untuk membuka fitur AI & WhatsApp lewat masa uji coba (trial) dan pembayaran sekali bayar (lifetime).
- Pemilik aplikasi (admin) punya kendali penuh untuk memantau pengguna dan mengatur akses berbayar.

## 3. Arsitektur Hosting & Integrasi

- **Index utama** (aplikasi KaslyAI yang sudah ada) akan digabungkan dengan alur pendaftaran & onboarding baru dari `prototype-flow.html`, jadi satu kesatuan.
- **Satu repository GitHub** dipakai untuk keduanya — index utama (aplikasi user) dan dashboard admin — masing-masing punya **link/path berbeda** di dalam repo yang sama (bukan 2 repository terpisah).
- Karena dashboard admin dilindungi **login sungguhan** (lihat di bawah), status repo publik/privat tidak lagi krusial untuk keamanan — yang melindungi data adalah proses login & pengecekan sesi, bukan "menyembunyikan link".
- **Keamanan akses dashboard admin**: pakai **Supabase Auth** (email + password sungguhan) — sudah dipakai sebagai backend proyek ini. Alurnya:
  - Admin login dengan email & password di halaman dashboard.
  - Berhasil login → sistem menyimpan **sesi/token** login.
  - Setiap kali halaman dashboard mau menampilkan data (daftar user, kode token, dll), sistem **mengecek dulu apakah sesi/token itu masih valid** sebelum data ditampilkan.
  - Data sensitif diambil dari database lewat permintaan yang **mewajibkan token valid** — bukan ditaruh mentah di dalam file HTML. Jadi walau seseorang menemukan link dashboard-nya, dia tetap tidak akan melihat data apapun tanpa berhasil login duluan.
- Kedua bagian (index utama & dashboard admin) **tersambung ke sistem/database backend yang sama** (Supabase) — supaya data user, token, dan pengaturan (trial, API key bersama, dll) selalu sinkron real-time.

### 3b. Catatan Keamanan Penting: Data User & API Key

- **Data user (nama, nomor WA, transaksi, dll) tidak pernah ada di dalam repo GitHub** — semua tersimpan di database (Supabase), terpisah dari kode program. Status repo publik/privat tidak memengaruhi keamanan data ini.
- **Kode program yang berjalan di browser (HTML/JS) selalu bisa dilihat siapa saja yang membuka websitenya** (lewat fitur "lihat source"/"inspect" browser) — ini berlaku untuk semua website, terlepas dari repo GitHub-nya publik atau privat. Jadi apapun yang "ditulis langsung" di kode front-end otomatis bisa diintip pengunjung.
- **Konsekuensi untuk API key Gemini bersama & API key pribadi admin**: kedua jenis key ini **tidak boleh dikirim ke browser user** dengan cara apapun. Kalau proses AI (chat, analisis transaksi, dll) memanggil Gemini langsung dari browser dengan key itu ikut disertakan, user yang paham teknologi bisa mengintip dan mencuri key tersebut lewat "inspect" browser untuk dipakai di luar aplikasi (menghabiskan kuota/biaya milik admin).
- **Wajib**: pemanggilan AI yang memakai API key bersama atau API key pribadi admin harus lewat **perantara di server (Supabase Edge Function)** — browser user cukup mengirim permintaan ("tolong analisiskan ini"), lalu server yang menyimpan & memakai API key itu di baliknya, hasilnya baru dikirim balik ke browser. Dengan begitu API key aslinya tidak pernah terkirim/terlihat di sisi browser manapun.
- API key milik user sendiri (yang dia input sendiri) risikonya lebih kecil karena itu kuncinya sendiri, tapi disarankan tetap ikut lewat pola yang sama (lewat server) demi konsistensi dan keamanan tambahan.
- **Data lintas-user di dashboard admin** (daftar semua user, dll) secara alami tidak bisa diambil lewat aturan keamanan per-akun biasa (karena aturan itu justru didesain supaya user hanya bisa lihat datanya sendiri). Untuk dashboard admin bisa menampilkan data SEMUA user, pengambilan datanya harus lewat jalur khusus di server yang mengecek dulu bahwa yang meminta memang admin yang sudah login sah (sesuai Supabase Auth di atas), bukan lewat akses langsung dari browser ke database.

## 4. Ringkasan Keputusan Utama

| Area | Keputusan |
|---|---|
| Login | Murni berbasis nomor WhatsApp — tanpa akun Google. Layar default adalah **Masuk** (nomor WA + kata sandi) untuk yang sudah punya akun; ada tombol terpisah **Daftar** untuk akun baru |
| Kata sandi | Dibuat sendiri oleh user saat proses Daftar (bukan sandi sementara/acak buatan sistem) — dipakai untuk Masuk di kemudian hari |
| Alur Daftar (akun baru) | Isi nama + nomor WA, centang persetujuan Syarat & Kebijakan Privasi, verifikasi lewat kirim kode unik ke WA resmi "KaslyAI", buat kata sandi sendiri → lanjut onboarding (pilih AI, setup dompet & kategori) → masuk ke aplikasi |
| Alur Masuk (akun sudah ada) | Isi nomor WA + kata sandi → langsung ke halaman utama, **tanpa** onboarding, **tanpa** setup dompet/kategori lagi |
| Isolasi data | Per akun (kunci akun = nomor WA terverifikasi), diatur di level penyimpanan data (bukan cuma tampilan) |
| API key AI (Gemini) — user | Saat onboarding, user memilih: **"AI Gratis (bawaan)"** (default, kuota dibagi bareng semua pengguna) atau **"API Key Gemini Sendiri"** (bisa tambah lebih dari satu key, makin banyak makin besar kuota gabungan). Ada panduan step-by-step cara ambil API key gratis dari Google AI Studio |
| API key AI (Gemini) — bersama | Pemilik aplikasi menyediakan API key bersama yang jadi opsi default semua user; jumlahnya diatur bebas lewat dashboard admin (tambah/kurangi kapan saja, tidak dipatok angka tetap) |
| API key AI (Gemini) — pribadi admin | Admin juga punya API key pribadi sendiri (terpisah dari API key bersama), khusus untuk kebutuhan AI admin sendiri (chat AI di dashboard, testing, asisten WA admin). Prioritas: API key pribadi admin dulu, baru jatuh ke API key bersama |
| Prioritas pemakaian key (user biasa) | API key milik user sendiri (kalau ditambahkan) dipakai duluan, baru jatuh ke API key bersama kalau habis/tidak ditambahkan |
| Nomor WhatsApp "KaslyAI" (resmi) | Satu nomor WA resmi aplikasi (**+62 812-2696-4679**, akun bisnis "Catatan Keuangan"), dipakai untuk 2 hal: (1) verifikasi pendaftaran, (2) fitur AI lewat chat WA. Terhubung lewat **WhatsApp Business Cloud API resmi dari Meta** (bukan penyedia pihak ketiga) |
| Nomor WhatsApp pribadi/bisnis admin | Nomor terpisah (**+62 896-2611-2023**), dipakai untuk chat closing penjualan (dari tombol "Chat Admin" di layar promo dalam app maupun di halaman promosi eksternal) & testing |
| Verifikasi WA | User isi nama + nomor WA + centang setuju S&K → tap tombol "Verifikasi via WhatsApp" → otomatis terbuka WA dengan pesan berisi kode unik yang sudah terisi (format: "Verifikasi KaslyAI, Kode: [kode]") ke nomor resmi KaslyAI → user tinggal tap kirim → sistem cocokkan kode + nomor yang didaftarkan + nomor pengirim → kalau cocok, akun aktif |
| Format kode verifikasi | 20 karakter kombinasi huruf besar-kecil & angka, menghindari karakter yang membingungkan (0/O, 1/l/I); berlaku selamanya sampai dipakai |
| Format kode token langganan | 8 karakter huruf besar & angka; dicocokkan tanpa memandang besar-kecil huruf (input otomatis diseragamkan jadi huruf besar) |
| Pengenalan ulang (device sama) | Otomatis dikenali lagi tanpa perlu verifikasi ulang, **kecuali** user sudah logout manual (lihat baris Logout di bawah) |
| Pengenalan ulang (device beda) | Wajib verifikasi ulang (kirim kode ke WA lagi) demi keamanan. **Verifikasi di device baru TIDAK memaksa logout device lain** yang sudah aktif — satu akun bisa login bareng di beberapa device sekaligus (HP + tablet, dll) tanpa saling mengganggu |
| Logout | Tombol "Keluar" di menu Pengaturan, dengan pop up konfirmasi ("Yakin mau keluar?") dan peringatan tambahan kalau ada data offline yang belum tersinkron. Begitu logout, sesi/pengenalan otomatis di device itu dihapus |
| Login ulang setelah logout / nomor WA sudah pernah terdaftar | User isi nomor WA + verifikasi ulang seperti biasa; kalau nomor itu ternyata sudah pernah terdaftar, begitu verifikasi berhasil **langsung masuk ke menu utama** dengan data yang sudah ada (skip seluruh proses onboarding — pilih AI, setup dompet, setup kategori) |
| Ganti akun di device yang sama | Dimungkinkan — user logout dari akun A, lalu login dengan nomor WA B (akun berbeda), asal masing-masing sudah logout sebelumnya |
| Onboarding setelah verifikasi | Carousel 4 slide penjelasan (fitur AI WA, asisten WA, fitur dasar gratis di web, pilihan sumber AI) → setup saldo awal dompet (bisa lebih dari satu) → setup kategori transaksi awal (income/expense, tambah/edit/hapus, pilih ikon & warna) → masuk ke aplikasi utama |
| Trial | 1 minggu (7 hari) default, berlaku untuk fitur AI (web & WA) saja, sama untuk semua user baru; bisa diatur manual lewat dashboard admin |
| Setelah trial habis | Fitur catatan/transaksi manual tetap gratis & penuh selamanya; fitur AI (web maupun WA) terkunci |
| Buka kunci lagi | User transfer manual ke admin (via chat WA) → dapat kode token → dimasukkan di pop up trial-habis atau menu setting |
| Model bayar | Sekali bayar untuk selamanya (lifetime); harga sama rata untuk semua orang saat ini, rencana jangka panjang (belum sekarang) ada 2 paket: dasar saja vs dasar+AI+WA |
| Token | Dibuat lewat tombol generate di dashboard admin, format 8 karakter; 1 kode = 1 akun selamanya, tidak bisa dipakai ulang |
| Dashboard admin — akses | Login sungguhan pakai **Supabase Auth** (email + password), dengan sesi/token; halaman dashboard mengecek validitas sesi dulu sebelum menampilkan data, dan data sensitif hanya bisa diambil lewat permintaan yang membawa token valid |
| Dashboard admin — isi | 3 menu: Pengguna (daftar user + statistik + cari/filter + kirim token + reset WA), Kode Token (daftar & generate kode), Pengaturan (lama trial, API key bersama, API key pribadi admin) |
| Halaman promosi | Halaman web terpisah untuk promosi (link dibagikan di TikTok), berisi: link ke aplikasi KaslyAI untuk coba trial, dan tombol WA yang mengarah ke nomor pribadi/bisnis admin untuk chat bebas & closing pembayaran |
| Interaksi AI via WA | WA murni jadi **jalur input** (foto struk/teks/voice note, selalu gratis). Begitu AI selesai memproses, transaksi **langsung tersimpan otomatis** (tanpa konfirmasi dulu), konfirmasi/koreksi dilakukan lewat **notifikasi PWA** (bukan balasan WA) dengan tombol Edit & Hapus |
| Toggle Balasan Otomatis WA | Pengaturan **per-user** (bukan global admin) di menu setting masing-masing: ON = tetap ada balasan WA seperti biasa, OFF = notifikasi PWA jadi satu-satunya cara konfirmasi |
| Notifikasi PWA | Muncul tiap ada transaksi baru dari WA atau dari pintasan "Transaksi AI"; isi ringkasan transaksi + tombol Edit (buka app ke layar edit) & Hapus (langsung terhapus 1 tap, dengan opsi undo begitu app dibuka lagi) |
| Transaksi data tidak lengkap (toggle OFF) | Tidak langsung tersimpan penuh — jadi draf/belum lengkap; notifikasi PWA berbeda tampilan ("butuh dilengkapi"), tap untuk buka ke layar edit dengan data yang sudah terbaca AI otomatis terisi |
| Transaksi data tidak lengkap (toggle ON) | AI tetap menanyakan balik lewat chat WA seperti biasa (mis. "Nominalnya berapa kak?"), transaksi baru tersimpan setelah dijawab |
| Pertanyaan umum di luar transaksi (toggle OFF) | Jawabannya tetap dikirim — lewat notifikasi PWA berisi jawaban ringkas (mis. "💰 Saldo kamu: Rp 1.250.000"), bukan balasan WA |
| Fitur mode terkunci (koreksi/limit/tujuan) saat toggle OFF | Dinonaktifkan total lewat WA (fitur percakapan panjang, tidak cocok jadi notifikasi); user diberi tahu lewat notifikasi PWA untuk pakai fitur ini di web, bukan didiamkan |
| Instalasi PWA — Ikon Utama | Aplikasi menawarkan prompt "Tambahkan ke Layar Utama"/"Install Aplikasi" secara otomatis (perilaku standar browser) saat pertama kali dibuka. Setelah dipasang, muncul ikon di layar utama HP dan aplikasi bisa dibuka seperti aplikasi biasa (tanpa address bar browser) |
| Pintasan Ikon Terpisah (Chat & Transaksi AI) | Berbeda dari App Shortcuts (tekan-lama), ini **2 ikon layar utama yang benar-benar terpisah**, masing-masing di-install manual lewat tombol tersendiri di menu Pengaturan ("Pasang Pintasan Chat" & "Pasang Pintasan Transaksi AI") — tidak otomatis. **Ikon Chat**: buka langsung ke fitur chat full-screen existing (tidak berubah, tidak pakai notifikasi PWA karena sudah ada reply-edit sendiri). **Ikon Transaksi AI**: jalur baru, terpisah dari fitur "Transaksi AI" di web yang tetap tidak berubah; langsung tersimpan otomatis + notifikasi PWA (Edit/Hapus). Ketiga ikon (Utama, Chat, Transaksi AI) membuka 1 aplikasi/data yang sama |
| Pendaftaran | Isi nama + nomor WA + centang setuju Syarat & Kebijakan Privasi (tanpa email/akun Google) |
| Konfirmasi pembayaran | Manual sepenuhnya lewat percakapan WA antara admin & user, tidak perlu sistem/form khusus |
| Notifikasi trial habis | Pop up di aplikasi mengarahkan user untuk berlangganan/hubungi admin, dengan kolom input kode akses langsung di situ |
| Kuota AI habis / API key salah-kadaluarsa | User dikasih pesan ramah buatan sendiri (bukan pesan error mentah dari Google), baik penyebabnya kuota habis maupun key yang salah/kadaluarsa; sistem otomatis pindah ke API key lain yang tersimpan |
| Mode offline | Aplikasi tetap bisa dipakai catat transaksi manual tanpa internet; data otomatis sinkron ke server begitu online lagi |
| Penyalahgunaan trial (ganti-ganti nomor WA) | Diterima sebagai risiko yang dianggap wajar; pengaman utama ada di penguncian nomor WA per akun |
| Status akun admin | Admin (pemilik aplikasi) tetap ikut aturan trial & butuh token seperti user biasa untuk akun KaslyAI pribadinya, tidak dibebaskan otomatis — supaya admin merasakan langsung pengalaman dari sudut pandang user |
| Fitur AI terkunci via WA | Kalau user kirim perintah AI lewat WhatsApp saat fitur terkunci (trial habis/belum bayar), diberi tahu lewat WA (kalau toggle-nya ON) atau notifikasi PWA (kalau toggle-nya OFF) & arahan hubungi admin |
| Migrasi nomor WA existing | Nomor WA yang sekarang sudah dipakai untuk testing otomatis didaftarkan/dihubungkan ke akun admin saat migrasi |

## 5. Peran Pengguna

- **User biasa**: Daftar pakai nama + nomor WA (tanpa akun Google), verifikasi via WA, buat kata sandi sendiri, jalani onboarding (pilih sumber AI, setup dompet & kategori awal), lalu memakai aplikasi pencatatan keuangan. Kunjungan berikutnya cukup Masuk pakai nomor WA + kata sandi, langsung ke halaman utama. Bisa memakai fitur AI selama trial/sudah bayar.
- **Admin (pemilik aplikasi)**: satu-satunya yang punya akses ke dashboard (path/link terpisah dari index utama, wajib login email & password lewat Supabase Auth) untuk memantau pengguna, generate & kirim token, atur lama trial, dan kelola API key (bersama maupun pribadi); akun KaslyAI pribadi admin sendiri tetap tunduk pada aturan trial/token seperti user biasa.

---

## 6. Tahapan Pengembangan

Pengembangan dibagi 3 fase besar, berurutan — tiap fase menghasilkan sesuatu yang bisa dites/dipakai sebelum lanjut ke fase berikutnya.

### FASE 1 — Pendaftaran, Verifikasi WA & Onboarding

**Tujuan:** Aplikasi berhenti memakai satu kode akses bersama, dan mulai punya akun sungguhan (berbasis nomor WA) dengan alur onboarding lengkap sebelum user masuk ke aplikasi utama.

**Cakupan pekerjaan — Alur Layar (disesuaikan dari prototype-flow.html, sekarang 2 alur terpisah):**

1. **Layar Promo/Welcome** (layar pertama dalam app) — perkenalan singkat KaslyAI, 3 poin fitur utama, tombol "Chat Admin" (untuk tanya-tanya/beli lifetime langsung, menuju nomor WA pribadi/bisnis admin), dan tombol lanjut ke **Layar Masuk**.
2. **Layar Masuk (default, untuk yang sudah punya akun)** — isi **nomor WhatsApp** + **kata sandi** → tap "Masuk" → begitu benar, **langsung ke halaman utama aplikasi** dengan data yang sudah ada, **tanpa** onboarding, **tanpa** setup dompet/kategori lagi. Di layar ini ada tombol/link **"Belum punya akun? Daftar"** untuk yang mau bikin akun baru.
3. **Layar Daftar (khusus akun baru)** — isi **Nama Lengkap** dan **Nomor WhatsApp Aktif**, centang persetujuan **Syarat & Ketentuan** dan **Kebijakan Privasi** (wajib dicentang sebelum tombol lanjut aktif), lalu tap "Lanjutkan & Verifikasi via WhatsApp".
4. **Layar Verifikasi WA** (bagian dari alur Daftar) — tap tombol "Verifikasi via WhatsApp" → otomatis terbuka WhatsApp dengan chat ke **nomor resmi WA "KaslyAI"**, pesan sudah terisi kode unik (format: "Verifikasi KaslyAI" + kode 20 karakter) → user tinggal tap kirim, tidak perlu ketik apa-apa → status berubah jadi "Menunggu konfirmasi…" lalu "✓ Nomor WA terverifikasi" begitu sistem mencocokkan kode+nomor terdaftar+nomor pengirim.
5. **Layar Buat Kata Sandi** (bagian dari alur Daftar, setelah verifikasi WA berhasil) — user membuat **kata sandi sendiri** (bukan sandi sementara/acak buatan sistem) yang nanti dipakai untuk Masuk di kemudian hari.
6. **Layar Onboarding (carousel 4 slide)** — hanya muncul di alur Daftar, sekali saja untuk akun baru:
   - Slide 1: penjelasan fitur AI pencatat otomatis via WA (kirim foto struk → tercatat otomatis).
   - Slide 2: penjelasan asisten WA (tanya saldo, catat transaksi langsung dari chat ke nomor resmi KaslyAI).
   - Slide 3: penjelasan fitur dasar gratis selamanya di web (dashboard, laporan, anggaran tanpa batas waktu).
   - Slide 4: **pilihan sumber AI** — "AI Gratis (bawaan)" (default, kuota dibagi bareng semua pengguna) vs "API Key Gemini Sendiri" (bisa tambah lebih dari satu key, makin banyak makin besar kuota gabungan milik sendiri). Kalau pilih pakai API key sendiri dan belum punya, ada link ke **panduan step-by-step** (dengan tangkapan layar) cara ambil API key gratis dari Google AI Studio.
7. **Layar Setup Saldo Awal Dompet** (khusus alur Daftar) — user isi nama & saldo awal untuk dompetnya (default 1 dompet "Dompet Utama"), bisa tambah lebih dari satu dompet.
8. **Layar Setup Kategori Transaksi Awal** (khusus alur Daftar) — kategori bawaan (pengeluaran & pemasukan) sudah tersedia, user bisa edit nama/ikon/warna, hapus, atau tambah kategori baru sendiri.
9. **Masuk ke Aplikasi Utama** — baik dari alur Daftar (setelah semua langkah di atas) maupun alur Masuk (langsung setelah login berhasil), user diarahkan ke aplikasi utama (index) yang sudah ada, siap dipakai mencatat transaksi.

**Cakupan pekerjaan — Verifikasi, Kata Sandi & Keamanan:**
- Sistem mencocokkan **3 hal** sebelum akun dianggap aktif/terverifikasi saat Daftar: kode unik yang diterima, nomor WA yang didaftarkan di web, dan nomor WA pengirim pesan. Ketiganya harus cocok.
- Kode unik verifikasi: 20 karakter kombinasi huruf besar-kecil & angka (menghindari karakter membingungkan seperti 0/O, 1/l/I), berlaku selamanya sampai dipakai (tidak ada batas waktu untuk saat ini). Verifikasi WA ini **hanya dilakukan sekali saat Daftar** — bukan syarat untuk Masuk di kemudian hari.
- **Masuk (login) selanjutnya cukup pakai nomor WA + kata sandi** — tidak perlu kirim kode via WA lagi setiap kali mau login.
- **Pengenalan ulang saat buka aplikasi lagi:**
  - Dari **device/browser yang sama**: otomatis dikenali lagi (tetap dalam status Masuk), tidak perlu isi ulang nomor WA/sandi — **kecuali** user sudah logout manual sebelumnya.
  - Dari **device/browser berbeda**, atau setelah logout: kembali ke **Layar Masuk**, cukup isi nomor WA + kata sandi (tidak perlu verifikasi WA lagi, karena itu hanya untuk Daftar). Satu akun didukung untuk login bareng di beberapa device sekaligus (misal HP + tablet) secara bersamaan — login di device baru **tidak memaksa logout** sesi di device lain yang sudah aktif.
- **Logout**: menu setting punya tombol **"Keluar"**. Begitu ditekan, muncul pop up konfirmasi ("Yakin mau keluar?"); kalau ada data offline yang belum sempat tersinkron ke server, muncul peringatan tambahan sebelum logout benar-benar diproses. Setelah logout, sesi/pengenalan otomatis di device itu dihapus — buka aplikasi lagi kembali ke Layar Masuk (isi nomor WA + kata sandi).
- **Ganti akun di device yang sama**: satu HP/device bisa dipakai bergantian oleh beberapa akun berbeda — user tinggal logout dari akun yang sedang aktif, lalu Masuk lagi pakai nomor WA + kata sandi akun lain (atau Daftar akun baru).
- Kalau nomor WA yang diisi di Layar Daftar **ternyata sudah pernah terdaftar sebelumnya**, sistem memberi tahu dan mengarahkan ke Layar Masuk, bukan memproses sebagai pendaftaran baru.
- **Lupa kata sandi**: di Layar Masuk ada link "Lupa kata sandi?" — user isi nomor WA, verifikasi ulang lewat kirim kode ke WA resmi KaslyAI (memakai mekanisme verifikasi yang sama seperti Daftar), begitu berhasil, user diminta buat kata sandi baru untuk menggantikan yang lama.
- Pesan WA masuk dari nomor yang belum pernah terverifikasi/terhubung ke akun manapun: diabaikan saja, tidak perlu dibalas otomatis.
- Nomor WA yang sekarang sudah biasa dipakai untuk testing aplikasi akan otomatis didaftarkan/dihubungkan ke akun admin saat migrasi ke sistem baru.

**Cakupan pekerjaan — Data & Penyimpanan:**
- Semua data pengguna (dompet, transaksi, kategori, anggaran, target, utang, dll) dikaitkan ke akun masing-masing (kunci akun = nomor WA terverifikasi).
- Pengamanan data dipasang di level penyimpanan data itu sendiri (bukan hanya di tampilan aplikasi), supaya user satu tidak akan pernah bisa melihat/mengubah data user lain — bahkan lewat cara-cara teknis sekalipun.
- Data yang sudah ada sekarang (milik pemilik aplikasi) dipindahkan kepemilikannya menjadi milik akun admin sendiri, sebagai user pertama.
- Alur baca-tulis data dibalik: server jadi sumber data utama, penyimpanan lokal di HP/browser cuma jadi salinan sementara — supaya data tetap konsisten kalau user buka dari beberapa perangkat/link berbeda.
- **Mode offline**: aplikasi tetap bisa dipakai untuk mencatat transaksi manual walau tidak ada koneksi internet. Data yang dicatat saat offline disimpan sementara di HP, lalu otomatis terkirim/tersinkron ke server begitu koneksi internet kembali tersambung.

**Cakupan pekerjaan — API Key Gemini:**
- Menu setting punya bagian untuk kelola API key Gemini milik user: pop up untuk tambah, bisa lebih dari satu (tidak dibatasi jumlah), tersimpan berdasarkan akun (server) — bukan cuma di HP.
- **API key bersama**: pemilik aplikasi menyiapkan API key Gemini yang bisa dipakai bersama oleh semua user secara default. Jumlahnya diatur lewat dashboard admin, bebas ditambah/dikurangi.
- Urutan prioritas pemakaian (user biasa): API key milik user sendiri dulu (kalau ada), baru jatuh ke API key bersama kalau habis kuota/belum ditambahkan.
- **Penanganan kuota habis**: sistem otomatis pindah pakai API key lain yang tersimpan, termasuk berpindah model Gemini kalau diperlukan — mengikuti cara kerja sistem existing, hanya disesuaikan supaya tiap akun punya kumpulan key masing-masing. User diberi pesan pemberitahuan yang ramah (bukan pesan error mentah) kalau semua key sedang tidak bisa dipakai.

**Cakupan pekerjaan — Instalasi PWA (Ikon Utama):**
- Aplikasi dikonfigurasi sebagai PWA yang bisa di-install (manifest, ikon, service worker dasar) sejak Fase 1 — ini fondasi yang dibutuhkan sebelum Ikon Chat & Ikon Transaksi AI (Fase 2) bisa dipasang.
- Browser menawarkan prompt "Tambahkan ke Layar Utama"/"Install Aplikasi" secara otomatis saat aplikasi dibuka (perilaku standar browser, tidak perlu tombol khusus untuk ikon ini).
- Setelah dipasang, aplikasi bisa dibuka dari ikon di layar utama HP layaknya aplikasi biasa, tanpa address bar browser terlihat.

**Kriteria selesai:**
- Browser menawarkan opsi install PWA saat aplikasi pertama dibuka, dan setelah dipasang muncul ikon di layar utama HP yang bisa dibuka tanpa address bar terlihat.
- User bisa menyelesaikan alur **Daftar**: isi nama+WA → verifikasi WA → buat kata sandi → onboarding (termasuk pilih sumber AI) → setup dompet → setup kategori → masuk ke aplikasi utama.
- User dengan akun yang sudah ada bisa **Masuk** cukup dengan nomor WA + kata sandi → langsung ke halaman utama, tanpa onboarding/setup dompet/kategori.
- Dicoba dengan 2 nomor WA berbeda: dipastikan data satu akun sama sekali tidak terlihat/tersentuh dari akun lain.
- Buka lagi dari device yang sama: tetap dalam status Masuk tanpa isi ulang apapun, data (termasuk API key yang tersimpan) tetap muncul utuh.
- Buka dari device berbeda: kembali ke Layar Masuk, cukup isi nomor WA + kata sandi (tidak diminta verifikasi WA lagi).
- Tombol lanjut di layar daftar tetap nonaktif sebelum checkbox persetujuan S&K dicentang.
- Tombol "Keluar" di Pengaturan memunculkan konfirmasi, dan peringatan tambahan kalau ada data belum tersinkron; setelah logout, buka aplikasi lagi kembali ke Layar Masuk.
- Coba isi nomor WA yang sudah terdaftar di Layar Daftar: diarahkan ke Layar Masuk, bukan diproses sebagai akun baru.
- Coba ganti akun di device yang sama (logout akun A, Masuk dengan nomor WA+sandi akun B): berhasil, dan data masing-masing akun tetap terpisah rapi.

---

### FASE 2 — Halaman Promosi & Fitur AI via WhatsApp

**Tujuan:** Menyiapkan jalur promosi (dari TikTok) yang mengarahkan calon user ke 2 tujuan berbeda — coba aplikasi gratis, atau chat langsung untuk closing pembayaran — sekaligus memastikan fitur AI WA berjalan sesuai status akun.

**Cakupan pekerjaan — Halaman Promosi:**
- Halaman web promosi terpisah (link ini yang dibagikan di TikTok, nama brand "KaslyAI"), berisi:
  - Link untuk mencoba aplikasi (menuju alur pendaftaran di Fase 1, dengan trial 7 hari untuk fitur AI).
  - Tombol WA yang mengarah ke **nomor WA pribadi/bisnis pemilik aplikasi** (bukan nomor resmi "KaslyAI") — untuk chat bebas dengan calon pembeli, closing pembayaran, dan pemberian kode token secara manual.
  - (Detail lengkap struktur & desain halaman ini ada di dokumen terpisah: PRD Desain Halaman Promosi KaslyAI + Prompt Google Stitch.)

**Cakupan pekerjaan — Fitur AI via WhatsApp (model baru: input WA + notifikasi PWA):**

> **Latar belakang perubahan**: mulai 1 Oktober 2026, balasan otomatis dalam chat WA (termasuk balasan dari AI) mulai dikenakan biaya per pesan oleh Meta. Karena itu, model interaksi diubah — WA tetap jadi jalur **input** (selalu gratis, karena user yang inisiasi), tapi sistem **tidak wajib membalas lewat WA lagi**. Konfirmasi dipindah ke **notifikasi PWA (push notification)** di HP, yang gratis dan tidak tergantung kebijakan Meta.

- **Alur transaksi masuk via WA**: user kirim foto struk/teks/voice note ke nomor resmi "KaslyAI" → AI (Gemini) membaca & memproses → transaksi **langsung tersimpan otomatis** (tanpa menunggu konfirmasi user) → **notifikasi PWA** dikirim ke HP user, isinya ringkasan transaksi (contoh: "Rp 50.000 - Makan Siang") dengan 2 tombol aksi:
  - **Edit** — membuka aplikasi langsung ke layar edit transaksi tersebut.
  - **Hapus** — transaksi langsung terhapus dalam 1 tap dari notifikasi (tanpa perlu buka aplikasi, tanpa pop up konfirmasi tambahan) — tapi begitu aplikasi dibuka lagi setelahnya, muncul opsi singkat **"Batalkan/Undo"** untuk jaga-jaga kalau salah pencet.
  - Tap badan notifikasi (bukan tombol) → membuka aplikasi ke halaman detail transaksi itu.
- **Transaksi dengan banyak kategori sekaligus** (misal dari 1 struk belanja campuran isinya beberapa jenis barang): AI memecahnya jadi **beberapa transaksi terpisah** (satu per kategori), masing-masing langsung tersimpan otomatis dan **mengirim notifikasi PWA sendiri-sendiri** (bukan 1 notifikasi gabungan) — supaya tiap transaksi tetap bisa di-Edit/Hapus secara individual.
- **Toggle "Balasan Otomatis WA" — pengaturan per-user**: di menu setting tiap user (bukan pengaturan global admin), ada saklar on/off untuk balasan otomatis WA:
  - **ON**: sistem tetap membalas di WA seperti model lama (selama masih gratis/sebelum Oktober 2026, atau kalau user tetap memilih membalas walau berbayar). Kalau data transaksi dari user **kurang lengkap** (misal nominal tidak disebut), AI tetap bisa **menanyakan balik lewat chat WA** seperti biasa (mis. "Nominalnya berapa kak?"), transaksi baru tersimpan setelah user menjawab.
  - **OFF**: sistem tidak mengirim balasan WA apapun — **notifikasi PWA jadi satu-satunya cara konfirmasi** untuk user itu. Karena tidak bisa "menanyakan balik" lewat WA, transaksi dengan data **kurang lengkap** (misal nominal tidak disebut) **tidak langsung disimpan penuh** — disimpan sebagai **draf/belum lengkap**, dan notifikasi PWA yang muncul **berbeda tampilannya** dari notifikasi transaksi normal (contoh: "⚠️ Transaksi butuh dilengkapi — tap untuk isi nominal"), tanpa tombol Hapus cepat. Tap notifikasi ini membuka aplikasi ke layar edit transaksi itu, dengan data yang sudah berhasil dibaca AI (kategori, nama item, dll) sudah terisi otomatis, tinggal user lengkapi bagian yang kurang.
  - Sama halnya kalau fitur AI sedang terkunci (trial habis/belum bayar): kalau toggle user itu ON, pesan "fitur terkunci" tetap dibalas lewat WA seperti biasa; kalau OFF, pemberitahuan itu juga ikut lewat notifikasi PWA saja, bukan balasan WA.
  - **Pertanyaan umum di luar transaksi** (misal "saldo saya berapa?", "total pengeluaran minggu ini?"): kalau toggle ON, AI jawab langsung lewat chat WA seperti biasa. Kalau toggle OFF, jawabannya tetap dikirim — tapi lewat **notifikasi PWA berisi jawaban ringkas** (contoh: "💰 Saldo kamu: Rp 1.250.000"), bukan lewat balasan WA.
  - **Fitur mode terkunci (koreksi saldo, limit anggaran, tujuan tabungan)**: fitur existing ini berupa percakapan bolak-balik yang panjang lewat WA (bukan sekali kirim-balas), jadi **tidak diadaptasi ke notifikasi**. Kalau toggle user itu OFF, fitur mode terkunci ini **dinonaktifkan total lewat WA** — kalau user tetap coba ketik 'koreksi'/'limit'/'tujuan', tetap diberi tahu lewat **notifikasi PWA** (bukan didiamkan), isinya semacam "Fitur ini perlu balasan WA aktif — nyalakan di pengaturan, atau pakai fitur ini langsung di aplikasi web". Kalau toggle ON, fitur mode terkunci berjalan seperti biasa (tidak berubah).
- Setelah akun terverifikasi (Fase 1), nomor WA user otomatis bisa dipakai untuk fitur AI lewat chat ke nomor resmi "KaslyAI" (kirim foto struk, tanya saldo, dll) — mengikuti model baru di atas.
- Kalau user ganti nomor HP dan ingin tetap pakai akun yang sama: penyambungan ulang ke nomor baru **harus lewat admin** (reset manual dari dashboard). Kalau tidak masalah ganti akun, user bebas daftar ulang dengan nomor WA baru.
- **Konten yang bukan transaksi (foto tidak berkaitan atau teks panjang/ngasal)**: kalau foto yang dikirim ke WA bukan struk/tidak berkaitan sama sekali dengan transaksi (misal foto pemandangan), atau pesan teksnya sangat panjang/tidak jelas maksudnya dan bukan indikasi transaksi — sistem **tidak memaksakan jadi transaksi ngawur**. AI membalas natural lewat chat WA menjelaskan bahwa itu bukan transaksi. **Ini berlaku selalu lewat balasan WA, terlepas dari posisi toggle "Balasan Otomatis WA" (ON maupun OFF)** — karena tidak ada transaksi yang perlu dikonfirmasi, jadi tidak memicu notifikasi PWA.

**Cakupan pekerjaan — Pintasan Ikon Terpisah (Chat & Transaksi AI):**
- Berbeda dari App Shortcuts (menu tekan-lama) — ini **2 ikon layar utama yang benar-benar terpisah** dari Ikon Utama (yang sudah dipasang di Fase 1), masing-masing di-install **manual satu-satu** oleh user, tidak otomatis.
- Menu Pengaturan punya 2 tombol terpisah: **"Pasang Pintasan Chat ke Layar Utama"** dan **"Pasang Pintasan Transaksi AI ke Layar Utama"**. Menekan salah satu tombol memicu prompt install PWA khusus untuk halaman/URL fitur itu saja.
- **Ikon Chat** (kalau dipasang): membuka langsung ke fitur chat full-screen yang sudah ada di aplikasi (tidak berubah dari sebelumnya, tidak memakai notifikasi PWA karena sudah ada cara koreksi sendiri lewat reply-edit).
- **Ikon Transaksi AI** (kalau dipasang): jalur input cepat **baru**, terpisah dari fitur "Transaksi AI" yang sudah ada di halaman web (fitur web itu tetap sama persis: AI parsing → daftar hasil → tombol konfirmasi → baru tersimpan, tidak diubah). Ikon baru ini alurnya **langsung tersimpan otomatis** begitu AI selesai memproses (tanpa daftar/konfirmasi dulu), lalu memicu notifikasi PWA yang sama seperti alur transaksi via WA di atas (dengan tombol Edit/Hapus + undo).
- Ketiga ikon (Utama, Chat, Transaksi AI) tetap membuka **1 aplikasi/data yang sama** di baliknya — bukan 3 akun/aplikasi berbeda.
- Pintasan **tidak wajib** dipasang — user bebas pakai fitur "Transaksi AI" dan "Chat" versi biasa dari dalam web tanpa perlu pasang ikon tambahan apapun.

**Fitur AI terkunci via WA:**
- Kalau ada user mengirim perintah AI lewat WhatsApp padahal fitur AI-nya sedang terkunci (trial habis/belum bayar), sistem memberi tahu bahwa fitur sedang terkunci — lewat WA (kalau toggle user itu ON) atau lewat notifikasi PWA (kalau toggle OFF) — dan mengarahkan user untuk menghubungi admin.

**Kriteria selesai:**
- Halaman promosi bisa diakses dan kedua tombol/link-nya berfungsi sesuai tujuan masing-masing (coba aplikasi vs chat closing).
- Kirim foto struk/teks/voice note ke WA resmi "KaslyAI": transaksi langsung tersimpan otomatis dan notifikasi PWA muncul dengan tombol Edit/Hapus yang berfungsi.
- Tombol Hapus di notifikasi berhasil menghapus transaksi dalam 1 tap, dan opsi undo muncul begitu aplikasi dibuka berikutnya.
- Toggle "Balasan Otomatis WA" di setting user berfungsi: ON tetap dapat balasan WA, OFF cuma dapat notifikasi PWA saja.
- Kirim data transaksi tidak lengkap (misal nominal tidak disebut): kalau toggle ON, AI menanyakan balik lewat WA; kalau toggle OFF, transaksi masuk sebagai draf dan notifikasi "butuh dilengkapi" muncul (beda dari notifikasi transaksi biasa).
- Tanya hal umum di luar transaksi (misal saldo) lewat WA saat toggle OFF: jawaban ringkas muncul lewat notifikasi PWA, bukan balasan WA.
- Coba masuk mode terkunci (koreksi/limit/tujuan) lewat WA saat toggle OFF: fitur tidak berjalan, notifikasi PWA muncul mengarahkan ke web.
- Pesan/notifikasi untuk fitur AI yang terkunci muncul sesuai posisi toggle user (WA kalau ON, notifikasi PWA kalau OFF).
- Kirim foto tidak berkaitan (misal foto pemandangan) atau teks panjang/ngasal yang bukan transaksi ke WA → AI membalas natural via chat WA menjelaskan itu bukan transaksi (berlaku terlepas dari posisi toggle), tidak asal dicatat jadi transaksi ngawur, dan tidak memicu notifikasi PWA.
- Tombol "Pasang Pintasan Chat" dan "Pasang Pintasan Transaksi AI" di menu Pengaturan masing-masing berhasil memicu prompt install terpisah; setelah dipasang, tiap ikon muncul terpisah di layar utama dan membuka langsung ke fitur terkait sesuai alurnya masing-masing.

---

### FASE 3 — Trial, Token, Pembayaran, dan Dashboard Admin

**Tujuan:** Mengatur siapa yang masih boleh pakai fitur AI (dan WA-nya), lewat masa uji coba dan sistem token berbayar, plus memberi admin alat untuk memantau semuanya lewat dashboard terpisah.

**Cakupan pekerjaan — Trial:**
- Begitu akun terverifikasi (Fase 1), masa trial otomatis aktif — fitur AI (web & WA) terbuka penuh tanpa perlu aktivasi manual dari admin. **Lama masa trial default 7 hari**, sama untuk semua user baru, dan bisa diatur manual lewat dashboard admin kalau mau diubah.
- **Akun KaslyAI pribadi admin sendiri juga tetap ikut aturan trial & token yang sama seperti user biasa** — tidak dibebaskan otomatis, supaya admin bisa merasakan langsung pengalaman dari sudut pandang user.
- **Perubahan lama trial tidak retroaktif**: kalau admin mengubah angka "Lama Masa Trial" di dashboard, yang terpengaruh **hanya akun baru** yang daftar setelah perubahan itu disimpan. Akun-akun yang sudah lebih dulu terdaftar tetap memakai lama trial yang berlaku saat mereka daftar (tanggal berakhir trial masing-masing akun sudah terkunci sejak awal, tidak ikut berubah).
- Setelah masa trial lewat dan belum ada token yang dimasukkan:
  - Pencatatan transaksi manual & fitur dasar aplikasi tetap bisa dipakai sepenuhnya, gratis, **selamanya**.
  - Fitur AI (baik dipakai lewat aplikasi/web maupun lewat WhatsApp) otomatis terkunci.
  - Muncul **pop up notifikasi** di aplikasi yang memberi tahu trial habis dan mengarahkan user untuk berlangganan/menghubungi admin, dengan kolom input kode akses langsung di situ.

**Cakupan pekerjaan — Pembayaran & Token:**
- Alur pembayaran **sepenuhnya manual**, dilakukan di luar sistem: user chat ke nomor WA pribadi/bisnis admin (dari tombol "Chat Admin" di layar promo dalam app atau di halaman promosi eksternal), transfer, lalu berkomunikasi dengan admin lewat percakapan WA biasa.
- Format kode token: **8 karakter** (huruf besar & angka), dicocokkan tanpa memandang besar-kecil huruf (input user otomatis diseragamkan jadi huruf besar saat validasi).
- Satu kode hanya bisa dipakai oleh **satu akun, satu kali, untuk selamanya** — begitu dipakai, kode itu tidak bisa dipakai lagi oleh akun lain (sistem menolak dan memberi tahu "kode ini sudah pernah dipakai akun lain").
- Kode yang salah/tidak ditemukan diberi pesan "kode tidak ditemukan / salah ketik".
- User memasukkan kode di kolom pada pop up trial-habis (atau di menu setting); begitu kode valid, fitur AI & WA terbuka kembali secara permanen untuk akun itu.
- Harga saat ini: satu harga sama untuk semua pengguna.
- Pengecekan status trial/berbayar dipasang di titik yang menghubungkan aplikasi ke layanan AI — bukan hanya di tampilan — supaya tidak bisa "dipaksa" tetap aktif oleh user yang cukup paham teknologi walau belum bayar.

**Cakupan pekerjaan — Dashboard Admin (sesuai admin-dashboard.html, disesuaikan dengan keamanan final):**

Halaman terpisah (path/link berbeda) di dalam repository yang sama dengan index utama, terhubung ke database yang sama.

- **Akses: login sungguhan pakai Supabase Auth** (email + password) — bukan lagi sekadar link rahasia.
  - Admin login dengan email & password di halaman dashboard.
  - Berhasil login → sistem menyimpan sesi/token.
  - Setiap kali halaman mau menampilkan data, sistem mengecek dulu apakah sesi/token masih valid.
  - Data sensitif (daftar user, kode token, dll) diambil dari database lewat permintaan yang mewajibkan token valid — bukan ditaruh mentah di file HTML. Kalau sesi tidak valid/belum login, halaman tidak menampilkan data apapun dan mengarahkan ke form login.
  - Konsisten dengan aturan multi-device di Fase 1: admin bisa login ke dashboard dari **beberapa perangkat/browser sekaligus** (misal 2 laptop bersamaan) tanpa saling logout paksa atau error — masing-masing sesi tetap valid dan bisa dipakai berbarengan.
- 3 menu utama (tab): **Pengguna**, **Kode Token**, **Pengaturan**.

**Menu Pengguna:**
- Ringkasan statistik di bagian atas: total pengguna, trial aktif, trial habis, sudah bayar.
- Kolom pencarian: cari berdasarkan nama atau nomor WA.
- Daftar user, tiap baris menampilkan: nama, **nomor WA (sebagian disamarkan demi privasi**, contoh format `0812xxxxxx74`), status (badge warna: trial/habis/sudah bayar), tanggal daftar, aktif terakhir, dan kode token yang dipakai (kalau sudah bayar).
- Tombol **"Kirim Token"** per user: begitu diklik, muncul konfirmasi ("Kirim kode token [X] ke akun [nama]?") → begitu dikonfirmasi, sistem **otomatis mengambil satu kode token yang belum dipakai dari stok** dan meng-assign ke user tersebut (admin tidak pilih manual kode mana) → tombol berubah jadi "Token Terkirim" (nonaktif). Kalau stok kosong, admin diberi pesan untuk generate kode baru dulu di menu Kode Token.
- Tombol **"Reset WA"** per user (tersedia di semua baris, bukan hanya yang trial habis): muncul konfirmasi ("Reset sambungan nomor WA untuk [nama]? Pengguna harus verifikasi ulang.") → begitu dikonfirmasi, sambungan WA user itu direset dan dia harus verifikasi ulang.
- Tombol **"Hapus Akun"** per user — beda dari "Reset WA" (yang cuma minta verifikasi ulang tapi **data lama tetap ada**), "Hapus Akun" ini **menghapus akun beserta seluruh datanya secara permanen**:
  - Data yang ikut terhapus: dompet, transaksi, kategori, anggaran/limit, tujuan tabungan, utang-piutang, riwayat chat, API key pribadi milik user itu, dan seluruh data lain yang terkait akun tersebut.
  - Karena aksi ini permanen & tidak bisa dibatalkan, konfirmasinya lebih ketat dari tombol lain: admin harus **mengetik "HAPUS"** di kolom konfirmasi dulu sebelum tombol Hapus Akun bisa ditekan (bukan cuma konfirmasi Batal/Oke biasa).
  - **Nomor WhatsApp yang sama tetap boleh dipakai lagi** untuk mendaftar sebagai akun benar-benar baru (lewat alur Daftar normal dari awal — verifikasi WA baru, onboarding, setup dompet & kategori dari nol) — nomor itu **tidak diblokir/dikunci** selamanya.
  - Kalau akun yang dihapus sebelumnya sudah pernah pakai kode token (status "sudah bayar"), kode token itu **tetap berstatus "sudah dipakai"** (tidak dikembalikan ke stok) — supaya konsisten dengan aturan "1 kode = 1 kali pakai selamanya" di bagian 4.
  - Setelah dihapus, baris user itu langsung hilang dari daftar Pengguna & angka ringkasan statistik ikut menyesuaikan.

**Menu Kode Token:**
- Tombol "+ Generate Kode Token Baru" — membuat kode 8 karakter acak (huruf besar & angka), langsung masuk ke daftar teratas.
- Daftar kode token: menampilkan kode, status (belum dipakai/sudah dipakai — dengan keterangan dipakai oleh siapa kalau sudah).

**Menu Pengaturan:**
- **Lama Masa Trial** — input angka jumlah hari (default 7), tombol simpan, keterangan durasi yang sedang berlaku.
- **API Key Gemini Bersama** — daftar API key bersama (bisa lebih dari satu), tombol tambah key baru, tombol hapus per key. Ini yang jadi opsi "AI Gratis (bawaan)" untuk semua user.
- **API Key Pribadi (Admin)** — daftar API key khusus milik admin sendiri (terpisah dari yang bersama), untuk kebutuhan AI admin sendiri (chat AI di dashboard, testing, asisten WA admin). Prioritas pemakaian: API key pribadi admin dulu, baru jatuh ke API Key Bersama kalau kuotanya habis.

**Kriteria selesai:**
- User baru otomatis dapat akses penuh sejak akun terverifikasi sesuai lama trial yang berlaku saat itu, tanpa langkah tambahan.
- Lewat masa trial tanpa token: fitur AI (web & WA) benar-benar terkunci, fitur dasar tetap jalan normal selamanya, dan pop up notifikasi trial-habis dengan kolom input kode muncul.
- Kode token yang sudah dipakai satu akun, dicoba dipakai di akun lain: ditolak dengan pesan yang jelas.
- Admin mengubah angka lama trial di dashboard → hanya berlaku untuk akun baru yang daftar setelahnya; akun-akun yang sudah ada sebelumnya tidak ikut berubah tanggal berakhir trialnya.
- API key yang salah/kadaluarsa dipakai untuk fitur AI → muncul pesan ramah (bukan error mentah dari Google), dan sistem otomatis pindah ke API key lain yang tersimpan — sama seperti penanganan kuota habis.
- Dashboard admin dibuka dari 2 perangkat berbeda secara bersamaan (login admin di keduanya) → tidak error, dua-duanya tetap bisa dipakai bersamaan.
- Siapa pun yang membuka link dashboard admin **wajib login lewat email & password dulu** sebelum melihat data apapun; sesi tidak valid otomatis diarahkan ke form login.
- Admin bisa: melihat & mencari daftar user (dengan nomor WA tersamar), melihat ringkasan statistik, generate kode token baru, kirim token ke user tertentu (otomatis ter-assign dari stok), reset sambungan WA user tertentu, **menghapus akun user tertentu beserta seluruh datanya**, mengatur lama trial, dan kelola API key bersama maupun API key pribadinya sendiri.
- Tombol "Hapus Akun" tidak bisa ditekan sebelum admin mengetik "HAPUS" di kolom konfirmasi. Begitu dihapus, akun & seluruh datanya (dompet, transaksi, kategori, budget, tujuan tabungan, utang-piutang, dll) benar-benar hilang dari database — dan nomor WA yang sama bisa langsung dipakai untuk mendaftar akun baru dari nol tanpa hambatan.

---

## 7. Rencana Masa Depan (Di Luar 3 Fase Ini)

- **Paket harga bertingkat**: saat ini harga lifetime satu harga sama untuk semua. Ke depan dipertimbangkan dipecah jadi 2 paket — paket aplikasi dasar saja, dan paket dasar+AI+WA. Detail fitur & harga per paket belum dirancang, menunggu fase-fase inti selesai dulu.

## 8. Catatan Lain-Lain (Belum Final / Perlu Diperhatikan)

- **✅ Biaya pesan WhatsApp mulai 1 Oktober 2026 — sudah ada solusinya**: lihat model baru "Interaksi AI via WA" di Fase 2 (input via WA tetap gratis, konfirmasi pindah ke notifikasi PWA). Estimasi biaya resmi dari Meta Indonesia sendiri masih menunggu rilis resmi (diperkirakan terbit sebelum 1 September 2026); estimasi sementara sekitar Rp 356–395/pesan untuk balasan yang tetap memilih lewat WA (toggle ON).
- **Belum diputuskan — teknis notifikasi push**: mau pakai Web Push API langsung, atau lewat layanan seperti Firebase Cloud Messaging. Ini keputusan teknis yang bisa diambil saat pengerjaan, tidak mengubah PRD.
- **Dukungan notifikasi di iPhone**: tombol aksi (Edit/Hapus) langsung di notifikasi paling mulus di Android (Chrome); di iPhone dukungannya lebih terbatas. Bukan penghalang, tapi perlu disadari pengalamannya bisa sedikit beda antar platform.
- **Link/domain aplikasi**: untuk sementara tetap pakai hosting GitHub Pages yang sekarang, belum ganti ke domain custom. Bisa dipertimbangkan lagi nanti kalau sudah siap.
- **Batas percobaan verifikasi (anti-spam)**: belum diimplementasikan untuk saat ini (masih tahap testing aktif). Nanti kalau sudah mendekati rilis publik, perlu ditambahkan batas wajar percobaan minta kode verifikasi dalam periode waktu tertentu, supaya tidak disalahgunakan/di-spam.
- **Backup data**: untuk sementara mengandalkan mekanisme bawaan Supabase saja, belum ada solusi backup tambahan di luar itu.
- **Device tanpa WhatsApp terpasang**: tidak disediakan jalur alternatif — diasumsikan semua calon pengguna aplikasi ini sudah memiliki WhatsApp aktif di device yang dipakai mendaftar.

## 9. Catatan Perubahan

- **v3.0 → v3.1**: Menambahkan tombol **"Hapus Akun"** per user di tab Pengguna Dashboard Admin — beda dari "Reset WA" (data tetap ada, cuma minta verifikasi ulang), "Hapus Akun" menghapus akun **beserta seluruh datanya secara permanen** (dompet, transaksi, kategori, budget, tujuan tabungan, utang-piutang, dll), dengan konfirmasi ketik "HAPUS" karena sifatnya tidak bisa dibatalkan. Nomor WhatsApp yang akunnya dihapus **tetap boleh dipakai lagi** untuk mendaftar sebagai akun baru dari nol. Kode token yang sudah dipakai akun tsb tetap berstatus terpakai (tidak dikembalikan ke stok).
- **v2.9 → v3.0**: Hasil audit menyeluruh checklist uji coba vs PRD (semua Fase). Perubahan utama: (1) desain "Pintasan Aplikasi" diganti total — bukan lagi 1 ikon + menu tekan-lama, tapi **3 ikon layar utama terpisah** (Ikon Utama otomatis di Fase 1, Ikon Chat & Ikon Transaksi AI dipasang manual lewat tombol di Pengaturan pada Fase 2); (2) Fase 1 sekarang eksplisit mencakup instalasi PWA (Ikon Utama) sebagai kriteria selesai; (3) ditambahkan aturan penanganan foto/teks yang bukan transaksi via WA (AI balas natural lewat chat WA, berlaku terlepas dari posisi toggle); (4) ditegaskan perubahan lama trial admin **tidak retroaktif** (cuma akun baru); (5) penanganan API key diperluas mencakup key salah/kadaluarsa, bukan cuma kuota habis; (6) ditegaskan dashboard admin mendukung login bersamaan dari beberapa perangkat, konsisten dengan aturan multi-device user biasa.
- **v2.8 → v2.9**: Alur masuk aplikasi dirombak — layar default sekarang **Masuk** (nomor WA + kata sandi) terpisah dari **Daftar** (khusus akun baru). Saat Daftar, user membuat **kata sandi sendiri** (bukan sandi acak sistem) setelah verifikasi WA berhasil — kata sandi ini yang dipakai untuk Masuk selanjutnya, tanpa perlu verifikasi WA lagi tiap login. Akun yang sudah ada, begitu Masuk, **langsung ke halaman utama** tanpa onboarding/setup dompet/kategori. Fitur "device sama tetap login tanpa diminta ulang" tetap dipertahankan. Ditambahkan juga alur "Lupa kata sandi" yang memakai verifikasi WA untuk reset.

- **v2.7 → v2.8**: Menambahkan detail dari prototipe tampilan menu baru (`prototype-menu-baru.html`) — transaksi dengan banyak kategori sekaligus (dari 1 input/struk campuran) dipecah jadi beberapa transaksi terpisah, masing-masing dengan notifikasi PWA sendiri-sendiri (bukan digabung jadi 1 notifikasi).
- **v2.6 → v2.7**: **Fase 1 sudah dieksekusi di Antigravity IDE.** Konfirmasi provider WhatsApp = WhatsApp Business Cloud API resmi dari Meta langsung (bukan pihak ketiga), dengan nomor resmi KaslyAI **+62 812-2696-4679** dan nomor pribadi/bisnis admin **+62 896-2611-2023**. Tambahan penegasan: satu akun harus tetap bisa login bareng di beberapa device sekaligus tanpa saling logout paksa (verifikasi device baru tidak menginvalidasi sesi device lain). Ditegaskan juga: pemanggilan AI dengan API key milik user sendiri tetap wajib lewat Edge Function (server), dan migrasi data tidak langsung menghapus kolom access_code lama (dijaga sebagai cadangan sampai teruji stabil).

- **v2.5 → v2.6**: Menambahkan penanganan **fitur mode terkunci WA** (koreksi saldo, limit anggaran, tujuan tabungan — percakapan multi-langkah existing) saat toggle OFF — dinonaktifkan total lewat WA (tidak diadaptasi ke notifikasi karena sifatnya percakapan panjang), user diberi tahu lewat notifikasi PWA untuk pakai fitur ini di web.
- **v2.4 → v2.5**: Menambahkan penanganan **pertanyaan umum di luar transaksi** (misal "saldo saya berapa?") lewat WA saat toggle OFF — jawabannya tetap dikirim, lewat notifikasi PWA berisi jawaban ringkas, bukan balasan WA.
- **v2.3 → v2.4**: Menambahkan penanganan transaksi dengan **data tidak lengkap** (misal nominal tidak disebut) — kalau toggle "Balasan Otomatis WA" user ON, AI tetap menanyakan balik lewat chat WA; kalau OFF, transaksi disimpan sebagai draf dan notifikasi PWA khusus ("butuh dilengkapi") muncul, mengarahkan ke layar edit dengan data yang sudah terbaca AI otomatis terisi.
- **v2.2 → v2.3**: Menambahkan arsitektur **notifikasi PWA** sebagai pengganti balasan otomatis WA (mengacu dokumen `rencana-notifikasi-pwa.md`) — solusi untuk kebijakan biaya WA Meta mulai 1 Oktober 2026. Perubahan utama: (1) WA murni jadi jalur input, transaksi langsung tersimpan otomatis, konfirmasi lewat notifikasi PWA (tombol Edit/Hapus + undo); (2) toggle "Balasan Otomatis WA" jadi pengaturan **per-user**, bukan global admin; (3) tambah 2 pintasan aplikasi (App Shortcuts): Chat (existing) & Transaksi AI (jalur baru, terpisah dari fitur web yang ada).
- **v2.1 → v2.2**: Menambahkan bagian "Catatan Lain-Lain" — peringatan perubahan kebijakan biaya WhatsApp mulai Oktober 2026, serta keputusan sementara soal domain, batas anti-spam verifikasi, backup data, dan device tanpa WhatsApp.
- **v2.0 → v2.1**: Keamanan dashboard admin ditingkatkan — dari rencana "tanpa login, cuma link rahasia" menjadi **login sungguhan pakai Supabase Auth** (email/password + sesi token, data sensitif wajib token valid). Struktur hosting disederhanakan jadi **1 repository dengan 2 link/path berbeda** (bukan 2 repository terpisah) — karena keamanan sekarang bersumber dari login, bukan dari menyembunyikan link/repo.
- **v1.0 → v2.0**: Disesuaikan dengan prototipe final (`prototype-flow.html` & `admin-dashboard.html`). Perubahan utama: (1) alur onboarding jauh lebih detail — ada layar promo dalam-app, consent checkbox S&K, carousel onboarding 4 slide, pilihan sumber AI eksplisit, panduan ambil API key, setup dompet & kategori awal; (2) admin punya API key pribadi terpisah dari API key bersama; (3) format kode dipisah jadi 2: kode verifikasi (20 karakter) dan kode token (8 karakter, case-insensitive); (4) dashboard admin menampilkan nomor WA user yang disamarkan sebagian demi privasi.
- **Sebelumnya** (v1.0): Login diganti dari akun Google menjadi murni berbasis nomor WhatsApp. Dokumen "Persiapan Login Google" yang sempat dibuat sudah tidak relevan/tidak dipakai lagi.

---

*Dokumen ini disusun berdasarkan hasil diskusi kebutuhan bersama pemilik aplikasi, dan disesuaikan dengan prototipe HTML final yang sudah dibuat. Bisa direvisi kapan saja seiring diskusi lanjutan.*
