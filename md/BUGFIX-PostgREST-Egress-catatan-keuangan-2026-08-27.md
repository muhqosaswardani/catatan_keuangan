# Bug Fix Execution Brief — Kurangi PostgREST Egress (KaslyAI / catatan-keuangan)

**Untuk:** Antigravity IDE
**Project Supabase:** catatan-keuangan (`qdoduglbejcazjufvfkf`), region ap-southeast-1
**Repo:** `muhqosaswardani/catatan_keuangan`
**Tanggal audit:** 27 Agustus 2026
**Sumber data:** Live query ke `logs` (edge_logs) & database production via Supabase MCP, plus baca langsung kode `index.html` dari GitHub — bukan asumsi/dugaan, semua angka & baris kode di bawah dicek nyata.

**Fokus dokumen ini:** murni mengurangi **PostgREST Egress** (99.8% dari total egress project, 8.15 GB/5 GB free tier bulan ini). Bug keamanan (admin_delete_user, RLS, dll) sudah ditangani terpisah di file addendum sebelumnya — tidak diulang di sini kecuali menyinggung `user_settings` yang overlap.

---

## Ringkasan Akar Masalah (root cause, sudah dikonfirmasi di kode)

App ini punya satu fungsi sentral: **`syncAllWithSupabase(silent)`** (index.html baris ~10970–11351). Fungsi ini setiap kali dipanggil akan:

1. `SELECT *` **penuh** ke 8 tabel: `user_settings`, `transactions`, `categories`, `budgets`, `savings_goals`, `debt_entries`, `recurring_items`, `wallets`.
2. Merge dengan data lokal (localStorage).
3. **Upsert balik SEMUA baris hasil merge** ke tiap tabel — bukan cuma baris yang berubah.

Masalahnya: fungsi ini **dipanggil dari ~40 titik berbeda** di seluruh `index.html` — hampir setiap aksi user (tambah transaksi, edit dompet, ubah kategori, ubah budget, hapus item, dll), ditambah `window.addEventListener('focus', ...)` tiap kali tab/app kembali aktif. Tidak ada debounce, tidak ada cek "apakah datanya beneran berubah dari sync terakhir" — setiap trigger = full re-fetch + full re-upload 8 tabel dari nol.

**Bukti dari log (22.4 jam terakhir, 11.447 request REST):**
- Pola berulang persis setiap fungsi ini terpanggil: 8× `GET ...?select=*` + 8× `POST ...` (upsert) beruntun dalam <1 detik.
- Ini terjadi ratusan kali sehari (500+ full-select per tabel dalam window log yang ada), **hanya saat ada tab browser aktif** — begitu tab ditutup, traffic berhenti total (dikonfirmasi: tidak ada request REST 14 menit setelah tab terakhir tertutup, cuma health-check infra Supabase sendiri yang jalan).
- Tabel `user_settings` paling sering kena (karena juga jadi tempat nyimpan `nav_config`, `insight_cache`, `analysis_cache`, `chatHistory` — kolom besar yang ikut ke-fetch & ke-upload utuh tiap siklus walau isinya jarang berubah).

**Kenapa ini boros:** data di database sebenarnya kecil (`transactions` cuma 105 baris/152 KB, dll). Yang bikin 8+ GB egress bukan ukuran data, tapi **frekuensi full re-fetch + full re-upload** dari data kecil itu, dikali ratusan-ribuan kali oleh trigger yang kelewat agresif.

---

## Perbaikan yang Direkomendasikan (urut dari paling murah/cepat ke paling struktural)

### FIX-01 — Debounce/coalesce panggilan `syncAllWithSupabase` 🔴 (paling murah, dampak besar)

**Masalah:** Kalau user ngetik cepat / edit beberapa field beruntun, tiap aksi manggil sync-nya sendiri-sendiri — bisa numpuk 5-10 kali sync penuh dalam beberapa detik. Kode bahkan sudah punya flag `isSyncNeededAgain` yang re-trigger sync lagi setelah sync sebelumnya selesai (baris ~11348-11350) — pola ini memperparah, bukan menyelesaikan.

**Task:**
1. Bungkus semua pemanggilan `syncAllWithSupabase(true)` (yang dipanggil otomatis dari aksi user, BUKAN yang eksplisit klik "Sinkron Sekarang") lewat satu wrapper `scheduleSync()` yang men-debounce ke, misal, 3-5 detik:
   ```javascript
   let syncDebounceTimer = null;
   function scheduleSync() {
     clearTimeout(syncDebounceTimer);
     syncDebounceTimer = setTimeout(() => syncAllWithSupabase(true), 3000);
   }
   ```
2. Ganti ~40 titik pemanggilan `syncAllWithSupabase(true)` (kecuali yang dari tombol manual/klik user eksplisit dan boot pertama kali) jadi `scheduleSync()`.
3. Efek: 5 aksi beruntun dalam 3 detik = 1 kali sync, bukan 5 kali.

---

### FIX-02 — Cek `updated_at` dulu sebelum full fetch (incremental sync) 🔴

**Masalah:** Tiap sync selalu `select('*')` SEMUA baris tiap tabel, walau tidak ada perubahan sama sekali dari sync sebelumnya.

**Task:**
1. Simpan timestamp sync terakhir per device di localStorage: `localStorage.setItem('last_sync_at', Date.now())`.
2. Sebelum full sync jalan, panggil query ringan dulu — ambil `MAX(updated_at)` dari tiap tabel (atau cukup dari `user_settings.updated_at` sebagai penanda global kalau ada device lain yang baru sync):
   ```javascript
   const { data: check } = await supabaseClient
     .from('user_settings')
     .select('updated_at')
     .eq('user_id', currentUserId)
     .maybeSingle();
   const remoteChangedSince = check && new Date(check.updated_at).getTime() > lastSyncAt;
   ```
3. Kalau tidak ada tanda perubahan dari remote DAN tidak ada perubahan lokal yang pending (cek dirty-flag lokal) → **skip fetch, cukup push data lokal yang dirty aja** (kalau ada), jangan full pull.
4. Ini butuh sedikit lebih banyak kerja arsitektur dibanding FIX-01, tapi dampaknya jauh lebih besar untuk jangka panjang — terutama begitu jumlah transaksi bertambah banyak.

---

### FIX-03 — Jangan upsert ulang baris yang tidak berubah 🟠

**Masalah:** Di tiap bagian `syncAllWithSupabase` (transactions, categories, budgets, dst), kode selalu `pushRecs.length > 0 → upsert(pushRecs)` untuk **SEMUA** baris hasil merge — termasuk baris yang sama persis dengan yang sudah ada di server, bukan cuma baris yang baru diubah.

**Task:**
1. Tandai tiap record lokal dengan flag `_dirty` saat pertama kali dibuat/diubah oleh user.
2. Saat push balik ke Supabase, filter `pushRecs` supaya cuma kirim baris yang `_dirty === true`.
3. Reset flag `_dirty` ke `false` setelah upsert sukses.
4. Ini mengurangi ukuran body POST request (upload, bukan egress langsung, tapi biasanya PostgREST tetap mengembalikan representasi terbatas — dan mengurangi beban DB write yang jadi biang keladi hash comparison ulang di sync berikutnya).

---

### FIX-04 — Pisahkan kolom besar & jarang berubah dari `user_settings` 🟠

**Masalah (overlap dengan temuan BUG-03 sebelumnya):** `nav_config` (berisi `chatHistory`, `initialBalances`, dll), `insight_cache`, `analysis_cache` — semua ini ikut ke-`select('*')` dan ke-upsert **utuh** setiap kali `syncAllWithSupabase` jalan, padahal kontennya jauh lebih jarang berubah dibanding transaksi/wallet.

**Task:**
1. `insight_cache` dan `analysis_cache` — pindahkan ke tabel terpisah (`ai_insight_cache`, `ai_analysis_cache`) yang di-fetch cuma saat halaman Laporan/Insight dibuka, bukan di setiap sync umum.
2. `chatHistory`/`chatSession` — sudah direkomendasikan pindah ke tabel `ai_chat_history` terpisah di addendum sebelumnya (BUG-03 rekomendasi tambahan, masih opsional di sana). Dengan temuan egress ini, rekomendasi itu naik jadi **wajib**, karena `chatHistory` (263 item, terus nambah) ikut kebawa tiap sync selama masih nyatu di `nav_config`.
3. Sisakan di `user_settings` hanya field yang benar-benar perlu dicek tiap sync ringan (mis. `reset_at`, `deleted_ids`, `onboarded`).

---

### FIX-05 — Jangan sync ulang saat `window focus` kalau baru aja sync 🟡

**Masalah:** Baris ~23528: `window.addEventListener('focus', () => { syncAllWithSupabase(true); ... })`. Kalau user gonta-ganti tab/app berkali-kali (hal yang sangat umum di HP), tiap kali balik ke tab ini langsung full sync lagi walau baru beberapa detik yang lalu.

**Task:**
```javascript
window.addEventListener('focus', () => {
  const last = Number(localStorage.getItem('last_sync_at') || 0);
  if (Date.now() - last > 30000) { // minimal 30 detik sejak sync terakhir
    syncAllWithSupabase(true);
  }
  activateDuePendingTransactions();
});
```

---

### FIX-06 (jangka panjang, opsional) — Migrasi ke Supabase Realtime 🟢

Kalau FIX-01 s/d FIX-05 sudah jalan dan masih dirasa kurang, langkah paling struktural: ganti model "pull semua tiap ada aksi" jadi **subscribe** ke perubahan via Supabase Realtime (websocket), jadi device lain cuma dikirimin **diff**-nya aja, bukan full table tiap kali. Ini pekerjaan lebih besar (perlu redesain alur merge), jadi taruh di akhir setelah quick win di atas terbukti menurunkan angka egress.

---

## Cara Verifikasi Setelah Fix

Jalankan ini di SQL editor / minta Claude cek lagi setelah deploy, bandingkan dengan baseline sekarang (11.447 request REST / 22.4 jam):

```sql
select count(*) as total_request
from logs
where source = 'edge_logs'
  and event_message like '%/rest/v1/%'
  and timestamp > now() - interval '24 hours';
```

Target realistis: turun **signifikan** (idealnya >70-80%) begitu FIX-01 (debounce) dan FIX-02 (incremental check) jalan, karena itu langsung memangkas jumlah trigger sync, bukan cuma ukuran tiap sync.

Juga pantau dashboard **Settings → Billing → Usage → Egress** beberapa hari setelah deploy untuk lihat tren harian turun dari baseline ~950 MB/hari (PostgREST) yang tercatat 25 Agustus 2026.

---

## Urutan Eksekusi yang Disarankan
1. FIX-01 (debounce) — **hari ini**, paling murah & paling cepat kelihatan efeknya.
2. FIX-05 (throttle window focus) — **hari ini**, sekalian bareng FIX-01, satu baris kode.
3. FIX-03 (skip upsert baris tidak berubah) — **besok/minggu ini**.
4. FIX-04 (pisahkan chatHistory/insight_cache/analysis_cache) — **minggu ini**, sekalian lanjutan migrasi Storage yang sudah jalan (BUG-03).
5. FIX-02 (incremental select berbasis `updated_at`) — **minggu ini/depan**, butuh sedikit lebih hati-hati karena nyentuh logic merge inti.
6. FIX-06 (Realtime) — kapan saja setelah di atas stabil, tidak mendesak.
