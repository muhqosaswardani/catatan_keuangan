# Aturan Versioning Aplikasi Web, Dashboard Admin & Service Worker

> [!CAUTION]
> **ATURAN MUTLAK / WAJIB TANPA PENGECUALIAN:**
> Setiap kali ada perubahan pada file HTML (`index.html`, `admin-dashboard.html`, dll.) sekecil apapun perubahan tersebut (tweak 1 baris, CSS, teks, refactor, atau bug fix) dalam setiap sesi pengerjaan, Agent AI **WAJIB** menaikkan nomor versi di `index.html`, `admin-dashboard.html`, DAN `sw.js` sebelum commit/push!

---

## 1. Lokasi Versi yang Wajib Diperbarui Secara Bersamaan

1. **Aplikasi Utama (`index.html`)**:
   ```javascript
   const version = ' (v3.6.37)';
   ```
   *Cari dengan pattern `const version = ' (v`.*

2. **Service Worker PWA (`sw.js`)**:
   ```javascript
   const CACHE_VERSION = 'kaslyai-v3.6.37';
   ```
   *Cari `const CACHE_VERSION` — **WAJIB** dinaikkan agar browser/PWA pengguna otomatis flush cache lama dan memuat versi baru tanpa hard-refresh.*

3. **Dashboard Admin (`admin-dashboard.html`)**:
   ```html
   <span class="version-tag" id="adminVersionBadge">v3.6.37</span>
   ```
   *Terletak di pojok kanan atas `page-head` sebelah tombol "Keluar".*

---

## 2. Format & Ketentuan Increment

Format: `vMAJOR.MINOR.PATCH` (contoh: `v3.6.37` → `v3.6.38`)

- **PATCH** (Default): Setiap ada perubahan apapun sekecil apapun pada HTML/JS/CSS web (`v3.6.37` → `v3.6.38`).
- **MINOR**: Penambahan fitur baru yang signifikan (`v3.6.37` → `v3.7.0`).
- **MAJOR**: Redesign besar / breaking architectural changes (`v3.6.37` → `v4.0.0`).

---

## 3. Checklist Wajib Sebelum Commit & Push

Setiap kali mengedit `index.html` atau file frontend lainnya:
- [ ] Naikkan versi di `index.html` (`const version`)
- [ ] Naikkan `CACHE_VERSION` di `sw.js` (`const CACHE_VERSION`)
- [ ] Naikkan versi di `admin-dashboard.html` (`id="adminVersionBadge"`) jika ikut diubah
- [ ] Pastikan nomor versi konsisten dan tertulis di pesan commit git (contoh: `fix(chat): ... (v3.6.38)`)
