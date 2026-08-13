# Prompt: Perbaikan & Penyempurnaan — Fitur WhatsApp & Web Catatan Keuangan

Ini prompt perbaikan (bug fix + penyempurnaan kecil), BUKAN fitur baru. Kerjakan satu-satu, uji tiap perbaikan selesai sebelum lanjut ke poin berikutnya. **JANGAN mengganggu/merusak apapun yang sudah berjalan baik saat ini** — semua fitur yang sudah ada (transaksi, wallet, kategori, budget, laporan, cross-check, checklist, transaksi cepat, tujuan tabungan, insight AI, utang piutang, dan seluruh alur WA yang sudah jalan) harus tetap berfungsi persis seperti sekarang, kecuali poin-poin di bawah ini.

---

## 1. Keterangan WAJIB berupa barang/jasa yang jelas — kalau AI tidak tahu, harus tanya

Ini prinsip umum yang berlaku untuk SEMUA jenis input (teks, foto, maupun pesan suara), bukan cuma kasus foto: **field Keterangan tidak boleh pernah diisi dengan kata generik seperti "Pengeluaran" atau "Pemasukan"**. Kalimat seperti itu sebenarnya artinya AI **tidak tahu** itu transaksi apa — dan kalau AI tidak tahu, itu **tidak boleh ditutupi dengan kata generik**, AI harus **tanya balik ke user** apa sebenarnya transaksi itu (barang atau jasa apa), baru dicatat setelah user jawab dengan jelas.

Aturannya: **Keterangan harus selalu berupa nama barang atau jasa yang konkret** — sesuatu yang jelas dan masuk akal untuk ada nominalnya (contoh: "Lele bakar", "Ongkos parkir", "Token listrik"). Kalau dari input (foto/teks/VN) itu AI tidak bisa menyimpulkan barang/jasa apa yang dimaksud dengan yakin, **JANGAN ditebak/digeneralisir** jadi kategori "Lainnya" + keterangan "Pengeluaran" — itu sama saja mengarang. Sebagai gantinya, bot **wajib tanya balik dan minta konfirmasi** itu transaksi apa, baru transaksi dicatat setelah user menjelaskan.

## 2. Hapus semua emoji dari balasan WA, kecuali 1 pengecualian

Semua balasan bot di WhatsApp **tidak boleh pakai emoji apa pun** — KECUALI tanda centang (✓) yang memang dipakai khusus untuk menandai "Transaksi tercatat". Selain itu, tidak ada emoji lain di balasan manapun (termasuk untuk hapus transaksi, cek saldo, pesan error, dll — yang sekarang mungkin masih pakai emoji seperti 🗑️ atau 💰, itu semua dihapus).

## 3. Hapus tulisan dalam kurung seperti "(mis. ...)"

Balasan bot tidak boleh ada tulisan dalam kurung semacam "(mis. ...)" atau contoh-contoh serupa yang ditaruh dalam kurung. Tulis langsung to the point.

## 4. Balasan AI untuk obrolan umum jangan tampil sebagai JSON mentah

Sekarang kalau user chat sesuatu yang sifatnya obrolan umum/ambigu (bukan transaksi), balasannya kadang muncul dalam bentuk mentah seperti:
```
{
  "balasan": "Halo! Ada yang bisa dibantu..."
}
```
atau
```
{
  "message": "Siap, perintah sebelumnya udah aku batalkan ya..."
}
```
Ini salah — yang seharusnya tampil ke user cuma **isi kalimatnya saja langsung**, tanpa kurung kurawal, tanpa tanda kutip, tanpa nama field JSON-nya. Kemungkinan ini bug di sisi kode yang lupa "membongkar" hasil JSON dari Gemini sebelum dikirim balik ke WhatsApp — pastikan di semua jalur balasan (bukan cuma transaksi tercatat), isi pesannya yang benar-benar dikirim ke WA, bukan struktur datanya.

## 5. Bug sinkronisasi: hapus transaksi via WA tidak ikut terhapus di web

Ditemukan bug: waktu transaksi dihapus lewat perintah di WA (reply "hapus" atau "hapus transaksi terakhir"), balasannya bilang sudah terhapus — tapi pas dicek di aplikasi web, transaksi itu **masih ada, belum ikut terhapus**. Perbaiki supaya penghapusan dari WA benar-benar konsisten ke database yang sama dan langsung tercermin di web/APK juga.

## 6. Bug: hapus transaksi manual di web tidak update total saldo

Ditemukan bug lain: kalau hapus transaksi secara manual dari aplikasi web, **total saldo tidak ikut ter-update** (angkanya "nyangkut", tidak berubah walau transaksinya sudah hilang dari list). Pastikan **total saldo di semua dompet selalu real-time sinkron** dengan rincian transaksi yang benar-benar ada di database — bukan angka yang dihitung sekali lalu disimpan terpisah, tapi selalu dihitung ulang/konsisten dengan data transaksi terkini, di mana pun aksinya dilakukan (WA, web, atau APK).

## 7. Format balasan "cek saldo" diubah urutan & gaya tampilannya

Format baru yang diinginkan untuk balasan "cek saldo":
- **Dompet Utama** ditampilkan paling atas, dengan **teks bold**.
- **Dompet Tabungan** di bawahnya (tidak bold).
- Dompet-dompet lain (kalau ada), di bawah itu lagi (tidak bold — cuma Dompet Utama yang bold, yang lain semua tidak).
- Di paling bawah, ada **1 baris kosong sebagai jarak/padding**, baru setelah itu baris **Total Saldo**.

Jadi urutannya kebalik dari sebelumnya: rincian per dompet dulu di atas, Total Saldo di paling bawah (bukan di atas seperti sekarang).

## 8. Jangan ada pesan yang menggantung tanpa balasan sama sekali

Pernah ditemukan kasus: kirim 1 foto tanpa caption, tidak ada balasan/respons apa pun dari bot (seperti hilang begitu saja). Baru setelah kirim foto lain (dengan caption) dan itu berhasil, foto pertama yang tadi "gagal" itu kelihatannya ikut kepakai/kesangkut prosesnya.

**Ini tidak boleh terjadi.** Prinsipnya: **setiap pesan yang masuk ke bot WAJIB selalu mendapat balasan status** — baik itu berhasil dicatat, gagal dengan alasan jelas, atau minta klarifikasi. Tidak boleh ada kondisi di mana pesan user "hilang" tanpa respons apa pun, apapun penyebabnya (baik itu soal foto tanpa caption, error teknis, timeout, dll) — kalau memang gagal diproses, tetap wajib ada balasan yang bilang gagal dan kenapa, supaya user selalu tahu status pesannya, tidak dibiarkan menggantung tanpa kejelasan.

## 9. Bug: popup "Edit Transaksi" di web tidak tertutup setelah klik Hapus

Ditemukan bug di web: kalau di popup "Edit Transaksi" user klik tombol **Hapus**, transaksinya memang benar-benar terhapus dari data — tapi **popup-nya sendiri tidak ikut tertutup**, tetap kebuka nampilin data transaksi yang sudah tidak ada itu. Perbaiki supaya popup otomatis tertutup begitu proses hapus berhasil.

Sekalian tambahkan **notifikasi/pemberitahuan singkat** (toast atau semacamnya, sesuai gaya notifikasi yang sudah ada di app) begitu transaksi berhasil dihapus dari popup ini — supaya user dapat konfirmasi jelas bahwa aksi hapusnya benar-benar berhasil.

## 10. Bug: pengaturan "Susun Bottom Nav" tidak berfungsi

Di halaman Settings, ada pengaturan untuk menyusun ulang menu bottom nav (pindahkan halaman ke "Navigasi Utama" atau "Lainnya", geser urutan). Sekarang ini **masih suka nyangkut** — tidak bisa diedit, tombol geser (naik/turun) tidak berfungsi, dan perubahan yang dicoba dilakukan **tidak tersimpan/tidak berubah** sama sekali. Perbaiki supaya pengaturan ini benar-benar bisa diedit dan tersimpan dengan baik.

## 11. Bug: penyebutan dompet eksplisit di WA tidak dipakai

Kalau user secara eksplisit sebut nama dompet di pesan (contoh: "dari dompet tabungan kepake 250rb"), transaksinya **harus** dicatat mengurangi saldo dari **Dompet Tabungan** (dompet itu memang ada dan namanya jelas di web) — bukan default ke Dompet Utama seperti yang terjadi sekarang. Deteksi penyebutan dompet eksplisit ini belum berfungsi dengan benar di WA, tolong diperbaiki supaya kalau nama dompetnya disebut jelas di pesan, itu yang dipakai.

## 12. Bug: parsing pesan jelas kadang tercatat sebagai kategori/keterangan yang sama sekali tidak nyambung

Ditemukan kejadian: user kirim pesan yang jelas, misalnya "lele bakar 18rb", tapi hasil yang tercatat malah **kategori "Penyesuaian Saldo" dengan keterangan "Sisa saldo"** — sama sekali tidak berhubungan dengan pesan yang dikirim. Ini kemungkinan ada logic fallback yang salah kepicu (mungkin nyangkut ke logic fitur Cross-check/Penyesuaian Saldo yang tidak seharusnya ikut kepakai di jalur pesan WA biasa). Tolong ditelusuri kenapa ini bisa terjadi dan diperbaiki supaya pesan yang jelas selalu diproses sesuai isi pesannya, tidak "nyasar" ke kategori sistem seperti Penyesuaian Saldo kecuali memang user sedang pakai fitur cross-check.

## 13. Reply-to-edit/delete lewat Pesan Suara (VN) belum berfungsi

Fitur reply ke bubble transaksi untuk edit/hapus (dengan balas teks bebas ke bubble tertentu) sudah jalan. Tapi kalau **reply-nya pakai pesan suara** (bukan ketik teks), sekarang sistem menganggap itu "pesan kosong" dan gagal menentukan instruksinya (muncul balasan semacam "Kurang jelas nih: Pesan balasan user kosong"). Ini harus diperbaiki: **reply pakai VN ke bubble transaksi harus diperlakukan sama seperti reply pakai teks** — audio balasannya diproses (dikirim ke Gemini sebagai audio, dengan konteks transaksi yang sedang di-reply), supaya user bisa edit/hapus transaksi lewat pesan suara juga, tidak cuma lewat teks.

---

## CATATAN UNTUK YANG MENGERJAKAN

- Ini semua perbaikan, bukan pembangunan fitur baru — hati-hati jangan sampai memperbaiki satu hal tapi merusak hal lain yang sudah jalan baik.
- Kalau ada bagian yang penyebab teknisnya tidak 100% jelas dari deskripsi di atas (terutama poin 5, 6, dan 8 yang sifatnya bug), telusuri dulu kode yang ada untuk menemukan akar masalahnya sebelum asal menambal — jangan cuma menutupi gejalanya.
- Setelah semua poin ini selesai dikerjakan dan diuji, laporkan balik satu-satu perbaikan mana yang sudah beres dan sudah diuji seperti apa.
