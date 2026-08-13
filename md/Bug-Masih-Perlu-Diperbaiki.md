# Bug yang Masih Perlu Diperbaiki — WA & Web Catatan Keuangan

## 1. Alur konfirmasi "transaksi tidak jelas" — 2 hal belum benar

- Kalimat pertanyaan bot masih template kaku: *"Untuk apa transaksi sebesar Rp5.000 ini? Balas pesan ini dengan keterangannya. Contoh: 'Token listrik' atau 'Parkir'"*. Ganti jadi kalimat AI natural yang variatif, bukan template tetap.
- Setelah user membalas keterangannya (mis. reply "es campur"), jawaban itu **tidak dianalisis ulang untuk menentukan kategori** — selalu jatuh ke "Lainnya". Seharusnya jawaban itu dianalisis penuh oleh AI (kategori & field lain ikut disimpulkan), bukan cuma dipakai sebagai teks keterangan mentah.

## 2. Bug sinkronisasi: hapus transaksi via WA tidak ikut terhapus di web (masih tidak konsisten)

Sudah dicoba diperbaiki sebelumnya tapi **masih gagal, dan sifatnya tidak konsisten** — kadang berhasil kadang gagal, bukan selalu gagal. WA bilang sudah terhapus, tapi transaksi masih ada di web.

- Cakup SEMUA kalimat/sinonim niat batal/hapus yang mungkin diketik user, bukan cuma satu kata kunci tetap. Contoh: "batalkan", "hapus", "ga jadi", "gajadi", "cancel", "undo", atau frasa senada lain — semua wajib dikenali AI sebagai niat hapus/batal, lalu dieksekusi, dan hasilnya harus SELALU berhasil (tidak boleh ada kasus gagal diam-diam).
- Pastikan proses hapus di WA benar-benar menghapus row yang sama persis di database (Supabase) yang dibaca web — jangan sampai ada race condition, cache, atau delay antara "pesan konfirmasi terhapus dikirim ke user" vs "row benar-benar ter-delete di database".
- Perlu ditelusuri ulang lebih dalam akar penyebab ketidakkonsistenannya (bukan cuma ditambal ulang, harus tuntas 100% berhasil di semua kasus).

## 3. Bug total saldo Dompet Utama — ada efek domino

Total saldo Dompet Utama tidak akurat, padahal total pemasukan-pengeluaran dan jumlah transaksi sama. Fitur Cross-check/Penyesuaian Saldo menghitung penyesuaian dengan benar, tapi transaksi-transaksi SETELAHNYA tetap kena selisih yang sama terus-menerus (efek domino).

Dugaan akar masalah: saldo dompet kemungkinan disimpan sebagai *running total* yang "ditumpuk" dari transaksi ke transaksi, bukan dihitung ulang murni (SUM) dari seluruh riwayat transaksi tiap kali dibutuhkan. Tolong pastikan saldo SELALU hasil kalkulasi ulang dari riwayat transaksi valid saat ini, supaya tidak ada efek domino kalau ada 1 transaksi yang dihapus/diubah.

## 4. Format "cek saldo" — bold belum mencakup seluruh baris

Urutan & breakdown sudah benar, tapi bold cuma diterapkan ke kata "Dompet Utama" (label doang), bukan ke seluruh baris termasuk nominalnya. Harusnya seluruh baris **"Dompet Utama: Rp81.067"** ikut bold, bukan cuma **"Dompet Utama"**: Rp81.067.

## 5. Kebijakan emoji direvisi: hapus SEMUA, tanpa pengecualian

Sebelumnya tanda centang (✓) dikecualikan untuk "Transaksi tercatat". Sekarang **hapus juga** — tidak ada emoji dalam bentuk apa pun di balasan manapun.

## 6. Bug: grafik dashboard (pie & tren) di web berkedip/reset sendiri

Di halaman Beranda, grafik pie breakdown kategori dan grafik tren terus terlihat digambar ulang/reset tiap beberapa detik, padahal tidak ada refresh browser. Kemungkinan ada proses (polling/interval) yang memicu render ulang tanpa perlu — perbaiki supaya grafik cuma redraw kalau memang ada data baru.

## 7. Bug besar: logic AI klasifikasi & penggabungan kategori di WA tidak sesuai — akar masalah: WA pakai prompt/fungsi SENDIRI, bukan pakai logic dari web

> ⚠️ **BATASAN PERBAIKAN — WAJIB DIPATUHI:** Perbaikan di bug #7 ini **HANYA untuk sisi WA**. Fitur **"Transaksi via AI" di web (index.html) JANGAN DISENTUH SAMA SEKALI** — logic itu sudah 100% benar dan terbukti berfungsi. Jangan ubah, refactor, atau "rapikan" kode/prompt di fitur web tersebut dengan alasan apapun (termasuk alasan "supaya bisa di-reuse"), karena berisiko menimbulkan bug baru di fitur yang sudah jalan baik. Cukup **BACA/CONTOH logic & prompt yang ada di web sebagai REFERENSI**, lalu **terapkan/duplikasi logic yang setara ke sisi WA** (di kode/prompt WA sendiri, terpisah). WA boleh punya kode sendiri, asal HASIL akhirnya sama persis dengan hasil fitur "Transaksi via AI" di web untuk input yang sama.

Kalau foto struk yang SAMA PERSIS (tanpa keterangan tambahan apapun) diproses lewat fitur **"Transaksi via AI" di web**, hasil kategorisasi & penggabungannya **sudah 100% benar**. Tapi kalau foto yang sama dikirim lewat **WA**, hasilnya sering salah/tidak konsisten. Ini menunjukkan WA punya prompt/fungsi klasifikasi sendiri yang terpisah dari logic web, dan logic WA itulah yang salah/kurang lengkap — bukan logic webnya.

**Solusi yang diminta (khusus sisi WA saja):** Selaraskan aturan klasifikasi kategori & aturan penggabungan per-batch di prompt/fungsi AI milik WA, supaya perilakunya SAMA PERSIS dengan hasil fitur "Transaksi via AI" di web — dengan cara meniru/menyalin aturan yang relevan (bukan mengimpor/memanggil ulang fungsi web, dan bukan mengedit fungsi web).

Kebutuhan tambahan yang memang khusus/berbeda di WA (di luar aturan klasifikasi & penggabungan inti) tetap boleh ada sebagai layer tambahan khusus WA (misal: alur konfirmasi via reply chat, cek saldo, dsb) — itu tidak perlu disamakan dengan web.

**PENTING:** pastikan bug-bug lain di sisi WA yang sebelumnya sudah pernah diperbaiki (termasuk aturan-aturan di bawah ini) tidak regresi/muncul balik lagi setelah perbaikan ini.

Contoh kasus konkret yang salah di WA:

- **Contoh A** — Item: *"Ponds Men Pollution Out"* dan *"Autan Sakura Tube"* (2 struk terpisah, tapi dikirim dalam rentang waktu yang sama / 1 sesi/batch). Keduanya jatuh ke kategori yang sama (Belanja/kebutuhan rumah tangga), TAPI:
  - Dicatat sebagai 2 transaksi terpisah, padahal seharusnya DIGABUNG jadi 1 transaksi karena kategorinya sama dalam 1 batch.
  - Kategori yang dipakai malah "Lainnya", padahal seharusnya "Belanja".
- **Contoh B** — 4 struk beda item makanan/minuman (Cimory, Cimory hazelnut, Frestea madu, Ice cream aice) dikirim dalam 1 batch/sesi. Semuanya dicatat sebagai 4 transaksi terpisah dengan kategori "Makan", padahal:
  - Seharusnya DIGABUNG jadi 1 transaksi (karena 1 batch, kategori sama) — penggabungan berdasarkan KATEGORI, bukan berdasarkan nama produk/item.
  - Kategorinya salah — semua item ini (Cimory, Frestea, Ice cream) adalah minuman/camilan ringan, seharusnya masuk kategori **"Jajan"**, bukan "Makan".

**Definisi kategori Makan vs Jajan yang benar (terapkan ke sisi WA — di web sudah benar, jangan diubah):**
- **"Makan"** = makanan berat/pokok. Contoh: nasi, nugget, mie (mie ayam/mie goreng/indomie sebagai makanan berat), bakso, ayam geprek, lauk-pauk siap saji, dsb.
- **"Jajan"** = makanan/minuman ringan, camilan, minuman manis/kemasan. Contoh: es krim, kopi (instan/kemasan/kopi kekinian), ciki/snack, permen, cokelat, minuman manis/soda (Frestea, Sprite, dll), roti manis, dsb.

**Aturan penggabungan per batch yang wajib ditegakkan (khusus di sisi WA — di web sudah benar, jangan diubah):** kalau dalam 1 batch/sesi kirim foto yang sama, ada 2+ item dengan kategori yang SAMA, WAJIB digabung jadi 1 transaksi untuk kategori itu (amount dijumlah, note gabungkan semua nama item). Item dengan kategori BERBEDA tetap jadi transaksi terpisah masing-masing. Penggabungan berbasis KATEGORI, bukan berbasis kemiripan nama/jenis produk. Contoh perilaku yang benar: lihat langsung hasil penggabungan di fitur "Transaksi via AI" di web untuk batch foto yang sama — itu jadi acuan/pembanding hasil akhir yang harus dicapai juga di WA.
