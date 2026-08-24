# Konteks Project: Catatan Keuangan (KaslyAI) — 24 Agustus 2026

File ini buat di-paste/upload ke chat/sesi AI baru (Antigravity IDE, Claude, dll)
biar langsung nyambung konteksnya tanpa jelasin ulang dari awal.

> ⚠️ **PENTING — Keamanan Token**: File ini isinya credential sensitif.
> Simpan di tempat aman, JANGAN commit ke repo publik. Kalau ada token di bawah
> yang kebuka ke pihak lain, segera revoke & generate ulang:
> - GitHub → Settings → Developer settings → Personal access tokens
> - Supabase → Account → Access Tokens

---

## 1. Kredensial & Akses

### GitHub
- **Personal Access Token**: `[REDACTED_GH_PAT]`
- **Login**: `muhqosaswardani`
- **Scope**: Contents (Read/write), Secrets (Read/write), Workflows (Read/write), Metadata (Read-only) — sudah teruji bisa push commit langsung.
- **Cara pakai**: kasih token ini ke AI, dipakai lewat `curl`/`git` di bash tool buat clone/pull/push.

### Supabase
- **Project name**: `catatan-keuangan`
- **Project ref/ID**: `qdoduglbejcazjufvfkf`
- **Organization ID**: `wtesadczzqwomvohejsb`
- **Region**: `ap-southeast-1`
- **Host**: `db.qdoduglbejcazjufvfkf.supabase.co`
- **Supabase URL** (dipakai di kode): `https://qdoduglbejcazjufvfkf.supabase.co`
- **Anon/publishable key** (aman terbuka di browser, sudah embed di `index.html` & `sw.js`): `sb_publishable_QKdAJuIR4ue_tU4yQPvCmQ_3O1_0IGy`
- **Supabase Personal Access Token** (buat CI/CD, BEDA dari anon key di atas): `[REDACTED_SUPABASE_PAT]`
  - Nama token di Supabase: `catatan-keuangan`
  - Expires: 31 Des 2026
  - Disimpan sebagai GitHub Secret `SUPABASE_ACCESS_TOKEN` di repo (terenkripsi otomatis oleh GitHub), dipakai GitHub Actions/CI-CD — BUKAN dipakai langsung oleh AI.
- **Koneksi via OAuth connector** (buat chat/tools yang connect ke akun Claude): nempel ke akun Claude, bukan device. Kalau nggak otomatis kebaca, search connector Supabase & connect ulang.
- **SUPABASE_DB_PASSWORD**: ⚠️ **BELUM ADA / BELUM DISET** sebagai GitHub Secret. Ini penyebab job `migrate-database` di CI/CD gagal (lihat bagian Outstanding Tasks). Perlu diambil dari Supabase Dashboard → Project `catatan-keuangan` → Settings → Database → Database password, lalu ditambahkan sebagai GitHub Secret baru dengan nama `SUPABASE_DB_PASSWORD`.

---

## 2. Repository GitHub

- **Owner/repo**: `muhqosaswardani/catatan_keuangan`
- **Visibility**: Public
- **URL**: https://github.com/muhqosaswardani/catatan_keuangan
- **Commit terakhir (saat file ini dibuat)**: `bc0d001` — "Fase 2 Bagian 2: App Shortcuts (Chat & Transaksi AI Cepat) + push notif Edit/Hapus/Lengkapi"
- **Versi index.html saat ini**: **v2.9.45**

Struktur root:
- `.agents/` — konfigurasi agent (dari Antigravity IDE)
- `.github/workflows/deploy-supabase.yml` — CI/CD (lihat bagian 5)
- `Migrasi Single-User ke Multi-User/` — folder migrasi arsitektur lama
- `catatan-keuangan-backup-2026-08-18.json` — backup data
- `foto/` — asset gambar
- `index.html` — aplikasi utama (single-file, ~22.500 baris)
- `manifest.json` — manifest PWA (termasuk App Shortcuts: Chat & Transaksi AI)
- `sw.js` — service worker (push notification + App Shortcuts delete handler)
- `schema.sql` — skema database
- `supabase/` — `.gitignore`, `config.toml`, `functions/`, `migrations/`

---

## 3. Ringkasan Project

Aplikasi web pencatatan keuangan pribadi **KaslyAI**, single-file HTML frontend
(`index.html`), backend Supabase (Postgres) untuk sinkronisasi offline-first.
Fitur utama: dompet, transaksi, kategori, utang/piutang, laporan, "Tambah via AI"
(Gemini API), integrasi WhatsApp, push notification, App Shortcuts.

### Kapabilitas AI saat ini di repo
1. ✅ Baca & edit kode di repo GitHub
2. ✅ Push commit ke repo `catatan_keuangan`
3. ✅ Jalankan SQL langsung ke database Supabase
4. ✅ Deploy/update Supabase Edge Functions
5. ✅ Kelola environment variables project Supabase
6. ✅ List & cek migrations, extensions, branches Supabase
7. ❌ Akses ke Antigravity IDE dari Claude chat (tool terpisah, belum ada integrasi)
8. ❌ Hosting/deploy platform frontend (Vercel/Netlify/dll) — belum dipakai

---

## 4. Edge Functions (`supabase/functions/`)

| Function | Fungsi |
|---|---|
| `send-push-notification` | Kirim Web Push (VAPID) ke semua device 1 akun. Dipakai fitur notifikasi Fase 2 Bagian 1 & 2 (transaksi tersimpan/butuh dilengkapi). Sudah handle CORS. |
| `wa-webhook` | Integrasi WhatsApp — terima pesan WA, deteksi transaksi/query, balas otomatis, termasuk logic hapus transaksi & recalculate saldo dompet (`recalculateDbWalletBalances`). |
| `privacy-policy` | Halaman kebijakan privasi (statis). |

**Catatan keamanan penting**: Pemanggilan **Gemini API untuk fitur AI (termasuk
Transaksi AI existing & Transaksi AI Cepat/Fase 2 Bagian 2 yang baru) masih
LANGSUNG DARI BROWSER**, bukan lewat Edge Function proxy. API key (14 key,
base64-encoded — cuma obfuscation kosmetik, BUKAN proteksi asli) ada di
`index.html` (`GEMINI_API_KEYS`, ±baris 10477) dan dikirim di request langsung
ke `generativelanguage.googleapis.com`. Ini **technical debt yang sadar
dibiarkan sementara** (keputusan user 24 Agu 2026) — perbaikan (migrasi ke Edge
Function proxy) akan dikerjakan terpisah, belum sekarang.

---

## 5. CI/CD — `.github/workflows/deploy-supabase.yml`

Dua job:
1. **`deploy-functions`** — trigger otomatis tiap push ke `main` yang ubah
   `supabase/functions/**`. Pakai `SUPABASE_ACCESS_TOKEN` saja. ✅ Selama ini sukses.
2. **`migrate-database`** — trigger manual via tab Actions → Run workflow →
   isi `run_migration: yes`. Menjalankan `supabase db push --project-ref
   qdoduglbejcazjufvfkf`. ⚠️ **SEDANG GAGAL** (run #12 dan #13, 24 Agu 2026)
   — dugaan kuat karena `db push` butuh koneksi langsung ke Postgres (perlu
   `SUPABASE_DB_PASSWORD`), sedangkan job ini cuma dikasih `SUPABASE_ACCESS_TOKEN`
   (token API management, bukan password DB). **Perlu di-fix**: tambah GitHub
   Secret `SUPABASE_DB_PASSWORD` + update step migration supaya pakai
   `--password "$SUPABASE_DB_PASSWORD"`.

---

## 6. Migrations (`supabase/migrations/`)

| File | Status apply ke DB live |
|---|---|
| `20260812_wa_integration.sql` | ✅ Sudah (lama) |
| `20260814_wa_tahap2.sql` | ✅ Sudah (lama) |
| `20260815_grant_permissions.sql` | ✅ Sudah (lama) |
| `20260816_redesign_wallets.sql` | ✅ Sudah (lama) |
| `20260818_multiuser_migration.sql` | ✅ Sudah (lama) |
| `20260819_grant_multiuser_permissions.sql` | ✅ Sudah (lama) |
| `20260823_password_setup_flow.sql` | ✅ Sudah (lama) |
| `20260823_push_subscriptions.sql` | ✅ Sudah — tabel `push_subscriptions` dikonfirmasi ada & sesuai skema live (Fase 2 Bagian 1) |
| `20260824_fase2_bagian2_shortcuts.sql` | ❌ **BELUM ke-apply** — nambah kolom `is_draft` (tabel `transactions`) & `last_notif_deleted` (tabel `user_settings`). Terblokir oleh kegagalan CI/CD di atas. |

---

## 7. Outstanding Tasks

1. 🔴 **CI/CD migration gagal** — job `migrate-database` perlu `SUPABASE_DB_PASSWORD` (lihat bagian 1 & 5). **Prioritas tertinggi**, blocking migration terbaru.
2. 🟡 **Migration `20260824_fase2_bagian2_shortcuts.sql` belum jalan** — akibat dari poin 1. Fitur draft/undo di Transaksi AI Cepat jalan secara lokal tapi belum sync sempurna lintas device sampai ini di-apply.
3. 🟡 **RLS (Row Level Security)** belum di-setup lengkap untuk skema 8-tabel utama Catatan Keuangan (`wallets`, `transactions`, dll). RLS untuk `push_subscriptions` sudah beres.
4. 🟡 **Data dompet duplikat** — dua entri "Dompet Utama" sama-sama `isPrimary`, sisa migrasi single-user → multi-user, belum dibersihkan.
5. 🟢 **Technical debt keamanan**: Gemini API key ter-embed & dipanggil langsung dari browser (lihat bagian 4) — dibiarkan sementara atas keputusan user.

---

## 8. Status Fase 2 (App Shortcuts, Notifikasi, dst.)

- **Bagian 1 — Infrastruktur Notifikasi Push PWA**: ✅ Selesai & berfungsi (v2.9.37). Web Push API murni (bukan Firebase/FCM), VAPID key sudah di-setup.
- **Bagian 2 — App Shortcuts & Transaksi AI Cepat**: ✅ Selesai secara kode (v2.9.45), tapi migration DB-nya (poin 7.2) belum jalan. Fitur: shortcut ikon PWA "Chat" & "Transaksi AI", layar full-screen input teks/foto/suara → auto-save tanpa konfirmasi, auto-split multi transaksi, push notifikasi per transaksi dengan tombol Edit/Hapus/Lengkapi, tombol Hapus di notifikasi menghapus + recalculate saldo langsung dari service worker tanpa buka app, banner Undo saat app dibuka lagi.
- **Bagian 3 (webhook WA lanjutan), Bagian 4, Bagian 5**: belum dikerjakan — instruksi/PRD-nya belum diupload ke sesi ini.

---

## 9. Cara Pakai File Ini di Sesi/Tools Baru

Upload/paste file ini di awal chat/sesi, lalu bilang: *"ini konteks project
catatan keuangan saya, tolong pakai info ini."* AI akan langsung tau repo mana,
project Supabase mana, token apa yang dipakai, dan apa yang harus dilakukan
setiap kali ada perubahan (**wajib naikkan versi di `index.html` — lihat
`const version` di fungsi `updateSyncStatusUI`, ±baris 9900 — setiap push
commit ke `index.html`, walau perubahan kecil**).
