# Aturan Versioning Web App

## Lokasi Versi
Versi aplikasi web didefinisikan di file `index.html` pada baris yang berisi:
```javascript
const version = ' (v2.3.3)';
```
Cari dengan pattern `const version = ' (v` untuk menemukan lokasi tepatnya.

## Format Versi
Format: `vMAJOR.MINOR.PATCH` (contoh: `v2.3.3`)

- **MAJOR**: Perubahan besar / redesign total / breaking changes
- **MINOR**: Fitur baru yang signifikan
- **PATCH**: Bug fix, tweak kecil, perubahan styling, update teks, dll.

## Aturan Wajib

**Setiap kali melakukan `git push` yang mengubah file `index.html` (atau file web lainnya yang mempengaruhi tampilan/fungsi web app), WAJIB:**

1. Increment nomor versi di `const version` sebelum push
2. Untuk perubahan kecil (fix, tweak), increment PATCH (contoh: `v2.3.3` → `v2.3.4`)
3. Untuk fitur baru, increment MINOR dan reset PATCH (contoh: `v2.3.4` → `v2.4.0`)
4. Untuk perubahan besar/redesign, increment MAJOR (contoh: `v2.4.0` → `v3.0.0`)
5. Jangan lupa push perubahan versi bersama dengan perubahan kodenya (dalam commit yang sama atau commit terpisah, tidak masalah)

## Catatan
- Perubahan yang HANYA di file WA bot (`supabase/functions/wa-webhook/`) dan TIDAK menyentuh `index.html` TIDAK perlu update versi web
- Versi ini ditampilkan di UI web app sebagai label sinkronisasi, jadi user bisa melihat apakah mereka sudah pakai versi terbaru
