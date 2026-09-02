# Instruksi Fix: Saldo Dompet Tidak 100% Murni dari Transaksi

> **Untuk:** Antigravity IDE
> **Project:** KaslyAI — `muhqosaswardani/catatan_keuangan`
> **Dibuat:** hasil investigasi via Supabase MCP + review langsung ke `index.html` di repo
> **Status saat investigasi:** versi `v3.6.60`

---

## 0. TL;DR — Apa yang harus dieksekusi

1. Jalankan **migrasi data** di Supabase: baseline dompet **Sotya** (`5.000.000`) diubah jadi transaksi "Saldo Awal" yang terlihat. Baseline dompet **admin** (`-10.000`) **DIBUANG LANGSUNG**, bukan dimigrasi jadi transaksi — user (admin/pemilik project) memastikan tidak ada transaksi riil yang hilang senilai itu, jadi angka -10.000 dianggap sisa kesalahan lama, bukan data yang perlu dipertahankan (lihat Bagian 3.1 untuk dampaknya).
2. Ubah `index.html`: hapus total mekanisme `initialBalances` (baseline tersembunyi), ganti `recalculateWalletBalances()` jadi murni `SUM()` transaksi.
3. Hapus kode hotfix lama yang sudah jadi teknis utang (`init()` line ~25578).
4. Tambahkan `exclude_from_report: true` ke transaksi seed "Saldo Awal" di alur onboarding WA (biar konsisten dengan "Penyesuaian Saldo" yang sudah ada).
5. Bump versi `v3.6.60 → v3.6.61`, commit, push (branch `main`, akan auto-deploy edge functions kalau ada; migration SQL dijalankan manual langsung ke DB, bukan lewat GitHub Actions karena ini one-time data-fix, bukan schema change).

**Prinsip akhir yang disepakati (JANGAN DIUBAH):**
> Saldo dompet = 100% `SUM(transaksi)`. Tidak ada angka tersembunyi lain. Kalau transaksi "Saldo Awal" dihapus user, saldo dompet otomatis berkurang sesuai nilainya — ini perilaku yang DIINGINKAN, bukan bug, jangan ditambahkan proteksi khusus.

---

## 1. Root Cause — Kenapa saldo suka "meleset" walau sudah di-"Penyesuaian Saldo"

### 1.1 Mekanisme saat ini (BERMASALAH)

Saldo dompet dihitung di `recalculateWalletBalances()` (index.html, baris **13593–13640**):

```js
function recalculateWalletBalances() {
  const wallets = getWallets();
  const transactions = getTransactions();
  if (wallets.length === 0) return;

  const sums = {};
  wallets.forEach(w => { sums[w.id] = 0; });

  transactions.forEach(t => {
    if (isFutureDate(t.date)) return;
    const amt = Number(t.amount) || 0;
    if (t.type === 'expense') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] -= amt;
    } else if (t.type === 'income') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] += amt;
    } else if (t.type === 'transfer') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] -= amt;
      if (sums[t.toWalletId] !== undefined) sums[t.toWalletId] += amt;
    }
  });

  const cfg = getNavConfig();
  if (!cfg.initialBalances) cfg.initialBalances = {};
  let changed = false;

  const updatedWallets = wallets.map(w => {
    if (cfg.initialBalances[w.id] === undefined) {
      cfg.initialBalances[w.id] = (Number(w.balance) || 0) - (sums[w.id] || 0);
      changed = true;
    }
    const newBalance = (Number(cfg.initialBalances[w.id]) || 0) + (sums[w.id] || 0);
    if (w.balance !== newBalance) {
      w.balance = newBalance;
      w.updatedAt = Date.now();
      changed = true;
    }
    return w;
  });

  if (changed) {
    setWalletsLocalOnly(updatedWallets);
    setNavConfigLocalOnly(cfg);
  }
}
```

Jadi rumus saldo bukan `SUM(transaksi)` murni, tapi:

```
saldo = initialBalances[walletId]  (baseline tersembunyi, disimpan di user_settings.nav_config, BUKAN di tabel wallets/transactions)
      + SUM(transaksi wallet itu)
```

`initialBalances` ini **tidak keliatan di riwayat transaksi manapun**, cuma nongkrong di kolom `user_settings.nav_config->'initialBalances'` (JSONB), per-user, per-wallet-id.

### 1.2 Bukti baseline ini pernah korup & sudah ditambal manual (bukan diperbaiki akarnya)

Ditemukan 2 lapis "hotfix" tambal-sulam di kode:

**a) Di logic sync/merge config** (index.html, baris **12464–12480**):
```js
const mergedInitialBalances = {};
const localIB = localCfg.initialBalances || {};
const remoteIB = remoteCfg.initialBalances || {};
const allIBKeys = new Set([...Object.keys(localIB), ...Object.keys(remoteIB)]);
...
for (const key of allIBKeys) {
  const localVal = localIB[key];
  const remoteVal = remoteIB[key];
  if (remoteVal !== undefined && (remoteNavTs >= localNavTs || localVal === undefined || localVal === -1580233)) {
    mergedInitialBalances[key] = remoteVal;
  } else {
    mergedInitialBalances[key] = localVal !== undefined ? localVal : remoteVal;
  }
}
merged.initialBalances = mergedInitialBalances;
```
Perhatikan `localVal === -1580233` — angka ajaib yang di-hardcode sebagai kondisi khusus. Ini nandain baseline salah satu dompet PERNAH ke-corrupt persis jadi nilai itu, dan alih-alih benerin penyebabnya, ditambal dengan exception ini.

**b) Di `init()`, dijalankan tiap kali app dibuka** (index.html, baris **25577–25602**):
```js
async function init() {
  // Hotfix: Correct corrupted initial balance for Dompet Utama
  try {
    const rawNav = localStorage.getItem('fk_navconfig') || 'null';
    if (rawNav !== 'null') {
      const cfg = JSON.parse(rawNav);
      if (cfg && cfg.initialBalances) {
        let fixed = false;
        if (cfg.initialBalances['w_mssuo8zcgq0xlu'] === 4850000) {
          cfg.initialBalances['w_mssuo8zcgq0xlu'] = -10000;
          fixed = true;
        }
        Object.keys(cfg.initialBalances).forEach(wId => {
          if (cfg.initialBalances[wId] === -1580233) {
            cfg.initialBalances[wId] = -1690600;
            fixed = true;
          }
        });
        if (fixed) localStorage.setItem('fk_navconfig', JSON.stringify(cfg));
      }
    }
  } catch (e) { console.warn('Hotfix initialBalances error:', e); }
  ...
```
Ini adalah patch khusus, hardcoded ID dompet (`w_mssuo8zcgq0xlu` = "Dompet Utama" milik akun admin sendiri!) dan nilai spesifik. Artinya baseline dompet utama sendiri pernah ke-corrupt jadi `4850000`, lalu dipatch paksa jadi `-10000` — bukan dihitung ulang dari data asli, cuma ditebak/dipaksa.

**Kesimpulan:** mekanisme baseline tersembunyi ini SUDAH TERBUKTI rapuh dan pernah korup di production. Setiap kali fitur "Penyesuaian Saldo" / "Cek Saldo AI" dipakai, itu cuma menambal gejala (nge-set ulang saldo saat itu), TIDAK memperbaiki baseline yang mungkin sudah salah — jadi wajar kalau selisih muncul lagi di kemudian hari.

### 1.3 Verifikasi silang ke data live Supabase (dicek langsung via SQL)

Baseline (`initialBalances`) tiap user disimpan di `user_settings.nav_config->'initialBalances'`:

| access_code | initialBalances (hanya yang relevan) |
|---|---|
| `wa_da7b12d5-...` (akun admin/kamu) | `w_mssuo8zcgq0xlu: -10000`, `wallet_tabungan: 0` |
| `wa_8e19f46d-...` (user lain: **Sotya**) | `wa_w_c79aee13d19345d4: 5000000` |
| `wa_cab9c8d2-...` (user lain, trial) | `wallet_utama: 0`, `wa_w_19014c68302040be: 3000000` |

Dicek: `-10000` itu PERSIS sama dengan selisih (stored balance − sum transaksi) yang ditemukan di Dompet Utama kamu. Jadi confirmed, bukan kebetulan — itu memang baseline yang lagi aktif dipakai.

**Catatan penting:** `wa_w_19014c68302040be` (baseline 3.000.000 milik user cab9c8d2) **sudah tidak ada di tabel `wallets`** — dompetnya sudah terhapus tapi baseline-nya masih nyangkut yatim piatu di `user_settings`. Ini otomatis akan terlewat di migrasi karena migrasi cuma jalan untuk wallet yang masih ada — tidak perlu ditindaklanjuti, cukup diketahui saja.

Akun admin juga punya beberapa baseline "yatim" lain (dompet yang sudah dihapus): `w_mandiri_01` (355399), `w_msrpg1x4uztpho`, `w_mssuohi9irs59p`, `w_mswx4x9mwgks0r`, `w_mt08g5ww7rtfr3`, `w_mt08g5ww7rtfr3_probe` (355399 juga — kelihatan sisa testing), `wa_w_4add824e525e459f`. Semua ini aman diabaikan (tidak match wallet manapun yang masih hidup).

---

## 2. Skema tabel yang relevan (Supabase Postgres, project `qdoduglbejcazjufvfkf`)

**`wallets`**: `id (text, PK)`, `access_code (text)`, `name (text)`, `balance (numeric)`, `is_primary (bool)`, `sort_order (int)`, `created_at`, `updated_at`, `user_id (uuid)`

**`transactions`**: `id (text, PK)`, `access_code (text)`, `wallet_id (text)`, `to_wallet_id (text, nullable — dipakai type='transfer')`, `category_id (text)`, `category (text)`, `type (text: income|expense|transfer)`, `amount (numeric)`, `date (text, format YYYY-MM-DD)`, `note (text)`, `source (text, default 'app')`, `exclude_from_report (bool, default false)`, `user_id (uuid)`, `is_draft (bool, default false)`, `updated_at`

**`categories`**: `id (text, PK)`, `access_code (text)`, `name (text)`, `type (text)`, `icon (text)`, `color (text)`, `user_id (uuid)`, `updated_at`

**`user_settings`**: `access_code (PK)`, `user_id`, `nav_config (jsonb)` ← `initialBalances` ada di sini, `sheets_web_app_url`, dll.

Catatan field-naming: kolom Supabase pakai `snake_case` (`wallet_id`, `exclude_from_report`), tapi objek JS di client pakai `camelCase` (`walletId`, `excludeFromReport`). Saat nulis kode JS pastikan pakai camelCase; saat nulis SQL pastikan pakai snake_case.

---

## 3. LANGKAH 1 — Migrasi Data Supabase (jalankan lebih dulu, sebelum ubah kode)

### 3.1 Keputusan khusus soal baseline admin (-10.000)

Awalnya rencana Bagian 3 ini mau migrasi KEDUA baseline aktif jadi transaksi "Saldo Awal" (biar saldo akhir sama persis sebelum/sesudah). **Tapi untuk baseline admin (`w_mssuo8zcgq0xlu: -10000`), pemilik akun (admin) memutuskan untuk DIBUANG LANGSUNG, bukan dimigrasi** — alasannya:
- Nilai ini tidak mewakili transaksi riil apapun yang pernah dicatat di aplikasi (tidak ada di riwayat transaksi manapun).
- Sudah terbukti dari investigasi (Bagian 1.2) angka `-10000` ini sendiri adalah hasil hotfix tebakan (`4850000 → -10000`), bukan angka yang terverifikasi benar — jadi tidak ada dasar kuat untuk dipertahankan sebagai "sejarah keuangan".

**Konsekuensi:** begitu baseline ini dibuang & kode diganti ke pure-SUM, saldo Dompet Utama admin akan **naik Rp10.000 secara permanen, satu kali saat fix di-deploy** (dari Rp1.218.127 → **Rp1.228.127**). Ini perubahan yang disengaja & disetujui, BUKAN bug — beri tahu admin sebelum deploy supaya tidak kaget lihat saldo naik 10rb tanpa transaksi baru.

Kategori "Penyesuaian Saldo" sudah ada untuk Sotya (income & expense), dipakai untuk migrasinya:
- Sotya (`wa_8e19f46d-...`): income=`wa_cat_fabddd22bc8f41a5`, expense=`wa_cat_55ec2fa1f25e43c3`

Jalankan SQL ini via Supabase MCP / SQL editor (idempotent — aman dijalankan ulang, `WHERE NOT EXISTS` mencegah duplikat):

```sql
-- 1) Dompet Utama Sotya: baseline 5000000 (income, karena positif)
INSERT INTO transactions (id, access_code, wallet_id, category_id, category, type, amount, date, note, source, exclude_from_report, user_id)
SELECT
  'migr_saldo_awal_' || w.id,
  w.access_code,
  w.id,
  'wa_cat_fabddd22bc8f41a5',
  'Penyesuaian Saldo',
  'income',
  5000000,
  COALESCE(
    (SELECT MIN(t.date)::date - INTERVAL '1 day' FROM transactions t WHERE t.wallet_id = w.id OR t.to_wallet_id = w.id),
    w.created_at::date
  )::text,
  'Saldo Awal (Migrasi Sistem)',
  'app',
  true,
  w.user_id
FROM wallets w
WHERE w.id = 'wa_w_c79aee13d19345d4'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = 'migr_saldo_awal_' || w.id);

-- 2) Bersihkan SEMUA initialBalances di semua user (baseline tersembunyi tidak dipakai lagi setelah kode diubah,
--    termasuk baseline admin -10000 yang sengaja dibuang tanpa transaksi pengganti)
UPDATE user_settings
SET nav_config = nav_config - 'initialBalances'
WHERE nav_config ? 'initialBalances';
```

**Verifikasi WAJIB setelah migrasi:**
- Dompet **Sotya** (`wa_w_c79aee13d19345d4`) dan **Dompet Tabungan** admin (`wallet_tabungan`) → saldo harus **PERSIS SAMA** dengan sebelum migrasi.
- Dompet **Utama admin** (`w_mssuo8zcgq0xlu`) → saldo **HARUS naik jadi Rp1.228.127** (naik Rp10.000 dari sebelumnya Rp1.218.127) — ini yang diharapkan sesuai keputusan Bagian 3.1, bukan kesalahan.

```sql
select w.id, w.name, w.balance as stored_balance,
  coalesce((
    select sum(case when t.type='income' then t.amount when t.type='expense' then -t.amount else 0 end)
    from transactions t where t.wallet_id = w.id
  ),0)
  + coalesce((
    select sum(t.amount) from transactions t where t.type='transfer' and t.to_wallet_id = w.id
  ),0)
  - coalesce((
    select sum(t.amount) from transactions t where t.type='transfer' and t.wallet_id = w.id
  ),0) as computed_from_tx
from wallets w
where w.id in ('w_mssuo8zcgq0xlu','wa_w_c79aee13d19345d4','wallet_tabungan');
```
`stored_balance` dan `computed_from_tx` harus identik untuk **`wa_w_c79aee13d19345d4`** (Sotya) dan **`wallet_tabungan`** (admin). Untuk **`w_mssuo8zcgq0xlu`** (Dompet Utama admin), `computed_from_tx` boleh (dan seharusnya) **Rp10.000 lebih besar** dari `stored_balance` yang lama — itu jadi angka final setelah `recalculateWalletBalances()` versi baru jalan (Langkah 2). Kalau selisihnya bukan persis Rp10.000 di dompet ini, atau ada selisih di 2 dompet lainnya, **JANGAN lanjut ke Langkah 2** — stop dan investigasi dulu.

---

## 4. LANGKAH 2 — Perubahan kode `index.html`

### 4.1 Sederhanakan `recalculateWalletBalances()` (baris 13593–13640)

**Ganti seluruh fungsi** jadi:

```js
function recalculateWalletBalances() {
  const wallets = getWallets();
  const transactions = getTransactions();
  if (wallets.length === 0) return;

  const sums = {};
  wallets.forEach(w => { sums[w.id] = 0; });

  transactions.forEach(t => {
    // Selalu cek dari tanggal (isFutureDate), JANGAN pakai flag t.pending -- flag itu cuma field lokal
    // yg TIDAK ikut ke-sync ke Supabase (skema tabel transactions tidak punya kolom ini), jadi tiap kali
    // data ke-refresh dari server (remote menang di mergeEntities) flag-nya hilang & transaksi masa depan
    // ikut kehitung ke saldo. Turunan dari tanggal selalu benar, apa pun kondisi sync-nya.
    if (isFutureDate(t.date)) return;
    const amt = Number(t.amount) || 0;
    if (t.type === 'expense') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] -= amt;
    } else if (t.type === 'income') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] += amt;
    } else if (t.type === 'transfer') {
      if (sums[t.walletId] !== undefined) sums[t.walletId] -= amt;
      if (sums[t.toWalletId] !== undefined) sums[t.toWalletId] += amt;
    }
  });

  let changed = false;
  const updatedWallets = wallets.map(w => {
    const newBalance = sums[w.id] || 0;
    if (w.balance !== newBalance) {
      w.balance = newBalance;
      w.updatedAt = Date.now();
      changed = true;
    }
    return w;
  });

  if (changed) {
    setWalletsLocalOnly(updatedWallets);
  }
}
```

Perubahan: saldo = `SUM(sums[w.id])` langsung, tanpa baseline apapun. Komentar soal `isFutureDate` DIPERTAHANKAN (itu valid, tidak ada hubungannya dengan bug ini).

> ⚠️ Fungsi ini dipanggil dari banyak tempat (26 lokasi lain di file — cek dengan `grep -n "recalculateWalletBalances(" index.html`). TIDAK PERLU ubah lokasi manapun yang MEMANGGIL fungsi ini — signature & efeknya (mutasi `wallets` lalu simpan) tetap sama.

### 4.2 Hapus blok merge `initialBalances` di sync (baris 12464–12483)

Cari blok ini (di dalam fungsi sync/pull dari Supabase, sekitar baris 12403–12484):

```js
              const mergedInitialBalances = {};
              const localIB = localCfg.initialBalances || {};
              const remoteIB = remoteCfg.initialBalances || {};
              const allIBKeys = new Set([...Object.keys(localIB), ...Object.keys(remoteIB)]);
              const remoteNavTs = Number(remoteCfg.navConfigUpdatedAt || (remChkSettings.updated_at ? parseSafeDate(remChkSettings.updated_at) : 0)) || 0;
              const localNavTs = Number(localCfg.navConfigUpdatedAt) || 0;

              for (const key of allIBKeys) {
                const localVal = localIB[key];
                const remoteVal = remoteIB[key];
                if (remoteVal !== undefined && (remoteNavTs >= localNavTs || localVal === undefined || localVal === -1580233)) {
                  mergedInitialBalances[key] = remoteVal;
                } else {
                  mergedInitialBalances[key] = localVal !== undefined ? localVal : remoteVal;
                }
              }
              merged.initialBalances = mergedInitialBalances;

              setNavConfigLocalOnly(merged);
              recalculateWalletBalances();
```

**Hapus baris `mergedInitialBalances` sampai `merged.initialBalances = mergedInitialBalances;` (10 baris di tengah).** Sisakan:

```js
              setNavConfigLocalOnly(merged);
              recalculateWalletBalances();
```

(Baris `setNavConfigLocalOnly(merged)` dan `recalculateWalletBalances()` TETAP dipanggil — jangan dihapus, cuma bagian `initialBalances`-nya saja yang hilang.)

### 4.3 Hapus blok hotfix di `init()` (baris ~25577–25602)

Cari & hapus SELURUH blok ini (dari komentar `// Hotfix: Correct corrupted initial balance` sampai `catch` penutupnya):

```js
  // Hotfix: Correct corrupted initial balance for Dompet Utama
  try {
    const rawNav = localStorage.getItem('fk_navconfig') || 'null';
    if (rawNav !== 'null') {
      const cfg = JSON.parse(rawNav);
      if (cfg && cfg.initialBalances) {
        let fixed = false;
        if (cfg.initialBalances['w_mssuo8zcgq0xlu'] === 4850000) {
          cfg.initialBalances['w_mssuo8zcgq0xlu'] = -10000;
          fixed = true;
        }
        Object.keys(cfg.initialBalances).forEach(wId => {
          if (cfg.initialBalances[wId] === -1580233) {
            cfg.initialBalances[wId] = -1690600;
            fixed = true;
          }
        });
        if (fixed) {
          localStorage.setItem('fk_navconfig', JSON.stringify(cfg));
        }
      }
    }
  } catch (e) {
    console.warn('Hotfix initialBalances error:', e);
  }

```
Hapus total (tidak diganti apapun) — sudah tidak relevan setelah baseline dihilangkan.

### 4.4 Bersihkan referensi sisa `initialBalances` (cleanup, low-risk tapi disarankan)

Jalankan `grep -n "initialBalances" index.html` setelah 4.1–4.3, seharusnya masih tersisa di 3 tempat — bersihkan juga:

- **Baris ~11612–11626** (fungsi seed onboarding WA): hapus blok komentar + `initialBalancesMap` + key `initialBalances: initialBalancesMap,` dari objek `navConfigForNewUser`. Alasannya sudah tidak relevan (baseline dihapus total, bukan cuma di-set 0).
- **Baris ~12840 & ~12855** (fungsi `getNavConfig()`): hapus baris `const initialBalances = (raw && raw.initialBalances) ? raw.initialBalances : {};` dan hapus `initialBalances,` dari object yang di-return.

Setelah ini, `grep -n "initialBalances" index.html` harus **0 hasil**.

### 4.5 Tambahkan `exclude_from_report` ke seed transaksi onboarding WA (baris ~11573–11587)

Ini transaksi "Saldo Awal" yang dibuat pas user baru daftar lewat WhatsApp bot. Sekarang belum di-exclude dari laporan (beda dari transaksi "Penyesuaian Saldo" lain yang selalu di-exclude). Tambahkan `exclude_from_report: true` (catatan: di titik ini variabelnya sudah bentuk objek untuk insert ke Supabase langsung / camelCase tergantung konteks fungsi — sesuaikan penamaan field dengan konvensi kode di sekitar baris itu, cek apakah pakai `exclude_from_report` atau `excludeFromReport` di fungsi yang sama):

```js
          if (balance > 0 && seedCatId) {
            transactions.push({
              id: `wa_tx_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
              user_id: currentUserId,
              access_code: 'wa_' + currentUserId,
              wallet_id: walletId,
              category_id: seedCatId,
              category: seedCategory ? seedCategory.name : '',
              amount: balance,
              type: 'income',
              date: todayStr(),
              note: 'Saldo Awal',
              exclude_from_report: true,   // <-- TAMBAHKAN baris ini
              updated_at: new Date().toISOString()
            });
          }
```

> Catatan: alur ini cuma menangani `balance > 0`. Kalau ke depan ada kasus user mulai dengan saldo negatif (utang), perlu tambahan `else if (balance < 0)` dengan `type: 'expense', amount: Math.abs(balance)` — TAPI ini di luar scope fix sekarang, cukup dicatat sebagai potensi improvement, tidak wajib dikerjakan sekarang.

### 4.6 Yang TIDAK PERLU diubah (sudah otomatis benar setelah 4.1)

3 fungsi ini (`applyPenyesuaian` / Cek Saldo AI ~baris 19472-19504, `applyManualAdjustment` / Kelola Dompet ~baris 19610-19660, `startEditWalletBalance` / Edit Saldo ~baris 20110-20150) semua sudah otomatis benar tanpa perlu diubah, karena pola mereka (`wallet.balance = target; push transaksi selisih; recalculateWalletBalances()`) akan otomatis menghasilkan angka yang tepat begitu `recalculateWalletBalances()` murni SUM — TIDAK PERLU DISENTUH.

---

## 5. LANGKAH 3 — Version bump & push (WAJIB, sesuai aturan project)

1. Cari `const version = ' (v3.6.60)';` (sekitar baris 12002, di dalam `updateSyncStatusUI`).
2. Naikkan jadi `const version = ' (v3.6.61)';`
3. Commit semua perubahan (migrasi SQL sudah dijalankan terpisah ke DB, tidak ikut file — hanya perubahan `index.html` yang di-commit) dalam satu commit dengan pesan jelas, contoh:
   `fix: saldo dompet 100% murni dari SUM transaksi, hapus mekanisme initialBalances yang rapuh & pernah korup`
4. Push ke `main`.
5. Kasih tahu versi berapa sekarang setelah push (v3.6.61) supaya bisa dicek label sinkron di Beranda.

---

## 6. Testing manual setelah deploy (checklist)

- [ ] Buka app, cek saldo **Dompet Tabungan** — harus sama persis dengan sebelum fix.
- [ ] Cek saldo **Dompet Utama (admin)** — harus **naik Rp10.000** dari sebelumnya (Rp1.218.127 → Rp1.228.127). Ini disengaja (Bagian 3.1), bukan bug.
- [ ] Buka riwayat transaksi Dompet Utama admin — **TIDAK ADA** transaksi baru terkait migrasi (baseline -10rb sengaja dibuang tanpa transaksi pengganti).
- [ ] Tambah transaksi baru (income/expense) — saldo harus berubah sesuai.
- [ ] Hapus transaksi "Saldo Awal (Migrasi Sistem)" itu sebagai tes — saldo harus otomatis berkurang Rp10.000 (ini perilaku yang DIINGINKAN, bukan bug — sesuai keputusan "100% murni dari transaksi").
- [ ] Coba "Kelola Dompet" → Edit Saldo sekali, pastikan tetap bikin 1 transaksi penyesuaian dan saldo akhir sesuai yang diinput.
- [ ] Cek user lain (Sotya) kalau memungkinkan — saldo dompetnya harus tetap Rp5.000.000, dan sekarang ada transaksi "Saldo Awal (Migrasi Sistem)" income di riwayatnya.
- [ ] `grep -n "initialBalances" index.html` → pastikan 0 hasil.

---

## 7. Di luar scope fix ini (jangan dikerjakan sekarang, cukup dicatat)

- Dompet "Dompet Utama" milik user lain (Sotya) punya pola transaksi aneh: income Saldo Awal 5jt langsung diikuti expense "Penyesuaian Saldo Manual" -5jt di hari yang sama (saling meniadakan). Ini kemungkinan bug terpisah di alur onboarding/testing WA bot — perlu investigasi terpisah, tidak terkait langsung dengan fix baseline ini.
- RLS untuk 8 tabel utama (wallets, transactions, dll) masih belum lengkap (lihat catatan project sebelumnya) — di luar scope fix ini.
