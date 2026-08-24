# Aturan Versioning Aplikasi Web & Dashboard Admin

## Lokasi Versi
Versi aplikasi web & dashboard admin didefinisikan di dua lokasi:

1. **Aplikasi Utama (`index.html`)**:
   ```javascript
   const version = ' (v3.0.0)';
   ```
   *Cari dengan pattern `const version = ' (v` untuk menemukan lokasinya.*

2. **Dashboard Admin (`admin-dashboard.html`)**:
   ```html
   <span class="version-tag" id="adminVersionBadge">v3.0.0</span>
   ```
   *Terletak di pojok kanan atas `page-head` sebelah tombol "Keluar".*

## Format Versi
Format: `vMAJOR.MINOR.PATCH` (contoh: `v3.0.0`)

- **MAJOR**: Perubahan besar / redesign total / breaking changes (contoh: `v2.9.46` → `v3.0.0`)
- **MINOR**: Penambahan fitur baru yang signifikan (contoh: `v3.0.0` → `v3.1.0`)
- **PATCH**: Bug fix, tweak kecil, perubahan styling, update teks, dll. (contoh: `v3.0.0` → `v3.0.1`)

## Aturan Wajib untuk Agent AI (Antigravity IDE / Gemini)

**Setiap kali melakukan perubahan pada file `index.html` atau `admin-dashboard.html` (atau file web app lainnya yang mempengaruhi tampilan/fungsi web), Agent AI WAJIB:**

1. Increment nomor versi di `index.html` (`const version`) dan `admin-dashboard.html` (`id="adminVersionBadge"`) sebelum membuat commit/push.
2. Untuk perubahan kecil (bugfix, tweak, style update), increment PATCH (contoh: `v3.0.0` → `v3.0.1`).
3. Untuk fitur baru, increment MINOR dan reset PATCH (contoh: `v3.0.1` → `v3.1.0`).
4. Untuk perubahan arsitektur/redesign besar, increment MAJOR (contoh: `v3.1.0` → `v4.0.0`).
5. Pastikan nomor versi di `index.html` dan `admin-dashboard.html` **selalu sinkron 100% sama**.
6. Sertakan perubahan versi ini ke dalam pesan commit git.

## Catatan
- Perubahan yang HANYA di file WA bot (`supabase/functions/wa-webhook/`) dan TIDAK menyentuh `index.html` atau `admin-dashboard.html` TIDAK perlu update versi web.
- Versi ini ditampilkan di UI web app (label sinkronisasi) & Dashboard Admin (badge pojok kanan atas), sehingga pengguna dan admin dapat memastikan bahwa mereka sedang menjalankan versi aplikasi terbaru.
