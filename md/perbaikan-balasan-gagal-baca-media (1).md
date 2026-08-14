# Perbaikan: Balasan Bot WA saat Gagal Baca Media

## Latar Belakang

Ada 2 masalah yang mau dibereskan:

1. **Skenario 2 & 3** — kalimat klarifikasi ("X ini harganya berapa ya?" / "Rp Y ini buat bayar apa ya?") saat ini dikarang ulang oleh AI setiap kali dipanggil (isi & susunan kalimat berubah-ubah tiap run). Sumbernya fungsi `generateClarificationQuestion()` di `gemini.ts`.
2. **Skenario 1** — kalimat "gagal baca media" ternyata **sudah hardcoded** (bukan AI-generated), tapi tersebar di banyak titik di `handlers.ts` dan `index.ts` dengan **3 varian kalimat berbeda** untuk kasus yang secara konsep sama. Ini yang perlu diseragamkan.

Tujuan akhir: semua balasan "gagal baca/proses media" pakai kalimat yang **identik persis**, tidak ada variasi baik dari AI maupun dari copy-paste manual yang tidak konsisten.

**Aturan gaya bahasa tambahan:** semua template tetap di dokumen ini **tidak boleh diakhiri kata "ya"** sebelum tanda titik/tanya (mis. "...coba tulis lagi ya." → "...coba tulis lagi."). Ini berlaku untuk template baru yang dibuat maupun string existing yang sedang diseragamkan.

---

## Skenario 1 — Gagal baca/proses media (foto & voice note)

### Temuan: titik-titik yang sudah ada di kode (bukan AI-generated)

| # | File & baris | Trigger | Kalimat saat ini |
|---|---|---|---|
| A | `handlers.ts` L761-767 (`handleMediaBatch`) | Download semua media gagal → `parts` kosong | "Gagal membaca media yang kamu unggah. Coba kirim ulang ya, atau kamu bisa ketik manual atau kirim pesan suara (vn) saja." |
| B | `handlers.ts` L781-787 (`handleMediaBatch`) | `parseTransactions()` throw error | Sama persis dengan A |
| C | `handlers.ts` L791-797 (`handleMediaBatch`) | AI berhasil respons, tapi `items` kosong | "Tidak ketemu info transaksi dari media ini. Coba kirim ulang ya, atau kamu bisa ketik manual atau kirim pesan suara (vn) saja." |
| D | `handlers.ts` L913-921 (`handleAudioMessage`) | Download VN gagal | "Gagal membaca pesan suara (vn) yang kamu kirim. Coba kirim ulang ya, atau kamu bisa ketik manual saja." |
| E | `handlers.ts` L944-953 (`handleAudioMessage`) | `parseTransactions()` throw error (VN) | Sama persis dengan D |
| F | `handlers.ts` L957-964 (`handleAudioMessage`) | `items` kosong (VN) | Sama persis dengan D |
| G | `handlers.ts` L1008-1015 (`handleReplyToTransaction`) | Download VN gagal saat reply edit/delete | Sama persis dengan D |
| H | `index.ts` ~L150-160 (`enqueueAndScheduleMedia`, background catch) | Batch processing gagal total (foto/VN) | "Maaf, gagal memproses foto/suara Anda. Coba kirim ulang ya." |

**Catatan:** Titik I (`"Maaf, ada kesalahan internal. Coba lagi ya."` — catch-all generic di `index.ts` POST handler) **di luar scope** — itu untuk error tak terduga apapun, bukan spesifik media.

### Masalah

- A/B (foto, gagal total) vs D/E/G (VN, gagal total) beda kalimat — wajar karena beda jenis media, tapi **istilahnya perlu konsisten**.
- C (foto, kosong) beda kalimat pembuka dari A/B ("Tidak ketemu info transaksi" vs "Gagal membaca media") — ini **secara makna memang beda kasus** (AI berhasil baca tapi tidak ada transaksi, vs AI gagal baca sama sekali), jadi **boleh tetap beda**, tapi perlu diputuskan apakah tetap dipertahankan bedanya atau disamakan.
- F (VN, kosong) memakai kalimat yang **sama** dengan D/E (gagal total) — padahal secara makna ini mestinya sama kasusnya dengan C (berhasil baca, tapi kosong), bukan gagal baca. Ini **tidak konsisten dengan pola di foto**.
- H beda kalimat lagi dari A/B/D, padahal cakupannya sama (gagal proses media, background job).

### Template tetap yang ditentukan

**1. Template "gagal baca sama sekali" — dipakai di A, B, D, E, G, H:**
```
Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.
```

**2. Template "berhasil baca, tapi tidak ketemu info transaksi" — dipakai di C, F:**
```
Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.
```

Kedua template ini **sama untuk foto maupun VN** (tidak perlu dibedakan istilah "foto" vs "vn" lagi di kalimatnya, karena sudah generik mencakup keduanya lewat "ketik manual atau kirim pesan suara").

**Catatan perbedaan template 1 vs 2:** template 1 (gagal baca total) menyarankan "coba kirim ulang" karena kemungkinan besar penyebabnya teknis (media corrupt/tidak terbaca) — kirim ulang bisa membantu. Template 2 (berhasil baca, tapi kosong) **tidak** menyarankan kirim ulang, karena AI sudah berhasil membaca isinya dan memang tidak ada info transaksi di dalamnya — kirim ulang foto/VN yang sama tidak akan mengubah hasil, jadi langsung arahkan ke alternatif (ketik manual/VN).

---

## Skenario 2 — Foto ada nominal yang kebaca, tapi AI gagal baca gambarnya (tidak tahu itu buat apa)

**Sebelum (contoh, digenerate bebas oleh AI):**
> "Tadi habis jajan atau bayar apa ya yang Rp200.000? Balas pesan ini dengan keterangannya. Contoh: "Token listrik" atau "Parkir""

**Template tetap (dengan variabel `{nominal}`):**
```
Gagal membaca media yang kamu kirim, {nominal} ini buat bayar apa?
```

**Kondisi pemicu:** `context.type === "note"` di `generateClarificationQuestion()` (`gemini.ts`) — nominal sudah diketahui, tapi barang/jasanya tidak kebaca. Juga dipanggil ulang dari `completePendingNominal()` di `handlers.ts` (L1286-1294) untuk kasus note generik setelah user mengisi nominal manual.

**Contoh hasil akhir:**
- `"Gagal membaca media yang kamu kirim, Rp200.000 ini buat bayar apa?"`

---

## Skenario 3 — AI berhasil kenali barang/jasa dari foto, tapi nominalnya tidak kebaca

**Sebelum (contoh, digenerate bebas oleh AI):**
> "Es Campur kemarin habis berapa ya?"
> "Tadi beli Coca-Cola Zero Sugar habis berapa ya?"

**Template tetap (dengan variabel `{item}`, tanpa keterangan waktu seperti "tadi"/"kemarin"):**
```
{item} ini harganya berapa?
```

**Kondisi pemicu:** `context.type === "amount"` di `generateClarificationQuestion()` (`gemini.ts`) — note/nama barang sudah diketahui, tapi nominal tidak kebaca.

**Contoh hasil akhir:**
- `"Tissue wajah ini harganya berapa?"`
- `"Coca-Cola Zero Sugar ini harganya berapa?"`

---

## Skenario 4 — Pola "Contoh: ..." di pesan lain (di luar gagal baca media, tapi masih satu alur klarifikasi)

Ditemukan 2 pesan lain di `handlers.ts` yang masih memakai pola "Contoh: ..." — perlu dihapus supaya konsisten dengan prinsip "kalimat tetap, tanpa contoh yang bisa dianggap template kaku/robotik":

**A. `handlers.ts` L1347 (`handlePendingNominalReply`) — nominal tidak ketemu saat user diminta ketik manual:**

Sebelum:
```
Tidak ketemu angka nominalnya, coba tulis lagi ya. Contoh: "25rb" atau "25000"
```
Sesudah:
```
Tidak ketemu angka nominalnya, coba tulis lagi.
```

**B. `handlers.ts` L1075 (`handleReplyToTransaction`) — instruksi edit/delete tidak jelas, fallback reason:**

Sebelum:
```ts
`Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik ya. Contoh: "hapus", "500rb", "kategorinya makan"'}`
```
Sesudah:
```ts
`Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik'}`
```

**Catatan:** `instruction.reason` pada B tetap digenerate bebas oleh AI (dari `parseEditInstruction()` di `gemini.ts`) — di luar scope perubahan ini (lihat bagian "Yang TIDAK boleh diubah"). Yang diubah di sini hanya **fallback**-nya (string default kalau `reason` kosong/undefined).

---

## Instruksi Perubahan Kode

### 1. `gemini.ts` — Ubah `generateClarificationQuestion()` (baris 422-457)

Hapus seluruh isi fungsi yang membangun `prompt`, memanggil `callGeminiRaw()`, dan blok `try/catch`-nya. Ganti jadi langsung `return` template sesuai kondisi `context.type`, tanpa panggilan AI sama sekali:

- `context.type === "amount"` → return:
  ```ts
  `${context.note} ini harganya berapa?`
  ```
- `context.type === "note"` (atau selain `"amount"`) → return:
  ```ts
  `Gagal membaca media yang kamu kirim, ${formatRupiah(context.amount ?? 0)} ini buat bayar apa?`
  ```

Fungsi boleh tetap `async` / `Promise<string>` supaya caller yang sudah `await` tidak perlu diubah. Parameter `apiKeys` jadi tidak terpakai — boleh dibiarkan di signature (prefix `_apiKeys` atau komentar agar linter tidak protes unused-param).

### 2. `handlers.ts` — Seragamkan kalimat "gagal baca sama sekali"

Ganti isi string di baris **761-767 (A)**, **781-787 (B)**, **913-921 (D)**, **944-953 (E)**, **1008-1015 (G)** menjadi persis:
```
Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.
```

### 3. `handlers.ts` — Seragamkan kalimat "berhasil baca, tapi kosong"

Ganti isi string di baris **791-797 (C)** dan **957-964 (F)** menjadi persis:
```
Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.
```

### 4. `index.ts` — Samakan kalimat background catch (H)

Di `enqueueAndScheduleMedia()`, ganti string `"Maaf, gagal memproses foto/suara Anda. Coba kirim ulang ya."` menjadi template yang sama dengan poin 2:
```
Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.
```

### 5. `handlers.ts` — Hapus pola "Contoh: ..." di 2 pesan lain (Skenario 4)

- Baris **1347**: ganti jadi `'Tidak ketemu angka nominalnya, coba tulis lagi.'`
- Baris **1075**: ganti fallback jadi `` `Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik'}` `` — hanya bagian fallback-nya, `instruction.reason` sendiri tetap dari AI.

### 6. Yang TIDAK boleh diubah (di luar scope)

- `"Maaf, ada kesalahan internal. Coba lagi ya."` di catch-all generic `index.ts` POST handler — ini untuk error tak terduga apapun, bukan spesifik media, biarkan seperti semula.
- `cleanClarifiedNote()` — tetap pakai AI bebas untuk merapikan jawaban user setelah klarifikasi.
- `generateNaturalResponse()` — tetap pakai AI bebas untuk balasan chit-chat/non-transaksi.
- Field `note` hasil parsing transaksi (dari `buildTransactionPrompt` / `parseTransactions`) — tetap boleh bervariasi.
- Pesan lain yang tidak terkait "gagal baca media" (mis. `"Tidak ketemu angka nominalnya..."` di `handlePendingNominalReply`, pesan cek saldo, hapus transaksi terakhir, dll).

---

## Checklist Verifikasi Setelah Perubahan

- [ ] `generateClarificationQuestion()` di `gemini.ts` tidak lagi memanggil `callGeminiRaw()` sama sekali.
- [ ] Skenario 2 & 3 menghasilkan kalimat identik persis (bukan hanya mirip) setiap kali dipanggil dengan input yang sama.
- [ ] Titik A, B, D, E, G di `handlers.ts` dan titik H di `index.ts` semuanya memakai kalimat "gagal baca sama sekali" yang identik persis.
- [ ] Titik C dan F di `handlers.ts` memakai kalimat "berhasil baca, tapi kosong" yang identik persis.
- [ ] Pesan catch-all generic di `index.ts` (di luar konteks media) tidak ikut berubah.
- [ ] `cleanClarifiedNote()`, `generateNaturalResponse()`, dan field `note` transaksi tidak berubah perilakunya.
- [ ] Tidak ada import atau parameter yang jadi unused akibat penghapusan panggilan AI di `generateClarificationQuestion()`.
- [ ] Baris 1347 dan 1075 di `handlers.ts` sudah tidak mengandung kata "Contoh:" lagi.
- [ ] Sudah di-grep ulang seluruh `handlers.ts`, `gemini.ts`, `index.ts`, `whatsapp.ts` untuk pola `"Balas pesan ini"` dan `"Contoh:"` — pastikan tidak ada sisa di pesan yang dikirim ke user (pola di dalam prompt instruksi ke Gemini AI, seperti di `buildTransactionPrompt`, boleh tetap ada karena itu bukan pesan ke user).
- [ ] Tidak ada template di dokumen ini yang diakhiri kata "ya" sebelum tanda titik/tanya.
