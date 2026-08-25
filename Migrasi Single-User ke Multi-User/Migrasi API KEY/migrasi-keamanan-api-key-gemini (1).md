# Migrasi Keamanan API Key Gemini — KaslyAI

**Tujuan dokumen:** panduan kerja untuk Antigravity IDE dalam mengamankan seluruh sistem penyimpanan, distribusi, dan pemanggilan API Key Gemini (milik user maupun milik admin/bersama).

## ⚠️ Batasan Wajib (Scope)

**HANYA boleh menyentuh:** siapa yang menyimpan key, di mana key disimpan, siapa yang boleh membaca/menulis key, dan dari mana key dipakai untuk manggil Gemini.

**TIDAK BOLEH diubah sama sekali:**
- Logic bisnis (kapan AI dipanggil, alur transaksi, alur WA, dll)
- Flow / urutan langkah yang dilihat user
- Prompt yang dikirim ke Gemini
- Pemilihan model (`GEMINI_MODELS`, fallback antar model)
- Struktur response / parsing hasil AI
- Tampilan UI (kecuali penyesuaian minimal yang disebutkan eksplisit di dokumen ini, misal masking key)

Setiap perubahan kode WAJIB dicek: apakah ini soal *"siapa pegang key & dari mana key dipanggil"*, atau soal hal lain? Kalau hal lain, JANGAN diubah.

---

## 1. Peta Semua Titik yang Berhubungan dengan API Key (Inventory)

Ini semua titik di codebase yang menyentuh API key Gemini — tidak ada yang boleh terlewat.

### A. `index.html` (frontend app, dipakai user)
| Bagian | Baris (kira-kira) | Fungsi saat ini |
|---|---|---|
| `let userKeys = []` | ~9146 | Nyimpen key pribadi user di memory browser |
| `let sharedKeys = []` | ~9146 | Nyimpen key bersama admin di memory browser |
| `localStorage.setItem('fk_user_gemini_keys', ...)` | ~10058 | Nyimpen key pribadi user ke localStorage |
| `localStorage.getItem('fk_user_gemini_keys')` | ~10123 | Baca key pribadi dari localStorage |
| `localStorage.getItem('fk_admin_shared_keys')` | ~10169 | Baca key bersama dari localStorage (cache) |
| `fetch(... action: 'get_gemini_shared_keys')` | ~10177 | Minta key bersama dari backend (wa-webhook) |
| `fetch(... action: 'user_get_gemini_keys')` | ~10148 | Minta key pribadi user dari backend |
| `fetch(... action: 'user_update_gemini_keys')` | ~10087 | Simpan key pribadi user baru ke backend |
| `function getSettings()` | ~11301 | Baca `geminiApiKey` custom dari localStorage settings |
| `function getGeminiApiKey()` | ~11302 | Ambil 1 key aktif (custom / shared) untuk dipakai |
| `async function callGeminiRaw(key, parts, ...)` | ~14906 | **Manggil Gemini LANGSUNG dari browser**, key ditempel di URL query `?key=` |
| Modal `#modalApiKey` (Setting > API Key Gemini Saya) | ~8122 | UI input/hapus key pribadi user |
| `renderUserKeys()`, `maskKey()` | ~10029, ~10041 | Render daftar key user (sudah di-mask di tampilan, tapi key asli tetap ada di memory/localStorage) |

### B. `Migrasi Single-User ke Multi-User/admin-dashboard.html`
| Bagian | Baris (kira-kira) | Fungsi saat ini |
|---|---|---|
| `let sharedKeys = []` | ~810 | Nyimpen key bersama di memory dashboard admin |
| `localStorage.getItem('fk_admin_shared_keys')` | ~812 | Cache key bersama di localStorage browser admin |
| `fetch(... action: 'get_gemini_shared_keys')` | ~918 | Ambil key bersama dari backend |
| `async function syncSharedKeysToBackend()` | ~1135 | Kirim key bersama baru ke backend (`admin_update_shared_keys`) + langsung upsert ke tabel `global_settings` dari browser |
| `addSharedKey()` / `removeSharedKey()` | ~1153, ~1175 | Tambah/hapus key bersama dari UI admin |
| Login overlay (`#authOverlay`, `handleLogin`) | ~648–884 | Login admin pakai Supabase Auth — **hanya mengunci tampilan halaman**, tidak memvalidasi request ke backend |

### C. `supabase/functions/wa-webhook/index.ts`
| Bagian | Baris (kira-kira) | Fungsi saat ini |
|---|---|---|
| `async function resolveGeminiApiKeys(db, userId)` | ~42 | Ambil key pribadi user (dari `user_settings.shortcut_overrides.gemini_keys` atau tabel `token_gemini_user`) + key bersama (dari `user_settings` row `access_code='admin_shared_keys'`) — **ini jalur server-side, sudah relatif aman dari sisi pemanggilan Gemini** |
| Handler `action: "get_gemini_shared_keys"` | ~1121 | Balikin key bersama plaintext ke siapa pun yang request — **TIDAK ADA VERIFIKASI SESI/AUTH** |
| Handler `action: "admin_update_shared_keys"` | ~1107 | Timpa key bersama — **TIDAK ADA VERIFIKASI ADMIN** |
| Handler `action: "user_get_gemini_keys"` | ~1164 | Balikin key pribadi user plaintext berdasarkan `userId` kiriman — **TIDAK ADA VERIFIKASI bahwa pemanggil = pemilik `userId` tsb** |
| Handler `action: "user_update_gemini_keys"` | ~1141 | Timpa key pribadi user — **TIDAK ADA VERIFIKASI kepemilikan** |

### D. `supabase/functions/wa-webhook/gemini.ts` & `handlers.ts`
| Bagian | Fungsi saat ini |
|---|---|
| `callGeminiRaw(apiKeys, parts, ...)` di `gemini.ts` (~201) | Manggil Gemini dari server (Deno), menerima array `apiKeys` yang sudah di-resolve dari `resolveGeminiApiKeys` — **titik pemanggilan ini TIDAK perlu diubah**, hanya sumber `apiKeys`-nya (lihat bagian E) yang perlu dienkripsi saat disimpan |

### E. Database Supabase
| Objek | Isu saat ini |
|---|---|
| Tabel `public.token_gemini_user` (kolom `user_id`, `api_key` plaintext) | RLS: `FOR SELECT/INSERT/DELETE TO anon, authenticated USING (true)` — **bisa diakses siapa saja lewat Supabase REST API + anon key publik, tanpa autentikasi** |
| Kolom `user_settings.shortcut_overrides.gemini_keys` (JSONB, plaintext) | Key pribadi user, disimpan plaintext, dibaca/ditulis lewat action di wa-webhook tanpa verifikasi kepemilikan |
| Row `user_settings` dengan `access_code = 'admin_shared_keys'`, kolom `shortcut_overrides.gemini_shared_keys` (JSONB, plaintext) | Key bersama admin, plaintext, dibaca/ditulis lewat action tanpa verifikasi admin |
| Tabel `global_settings` (key `gemini_shared_keys`) | Disebut di `admin-dashboard.html` (~1149) sebagai upsert langsung dari browser admin — cek juga RLS-nya, kemungkinan ada key bersama versi kedua di sini |

---

## 2. Rencana Perubahan per Komponen

### Langkah 1 — Perbaiki RLS tabel `token_gemini_user` (prioritas tertinggi, paling sederhana)

Buat migration SQL baru, isinya ganti policy dari `USING (true)` menjadi berbasis kepemilikan:

```sql
-- Migration: fix_token_gemini_user_rls.sql

DROP POLICY IF EXISTS "Allow all to view own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to insert own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to delete own gemini keys" ON public.token_gemini_user;

-- Akses dari client (anon/authenticated) ditutup total.
-- Baca/tulis HANYA lewat Edge Function pakai service role key (bypass RLS by design).
CREATE POLICY "Deny all client access to token_gemini_user"
ON public.token_gemini_user
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);
```

**Catatan:** karena semua akses ke tabel ini seharusnya lewat Edge Function (yang pakai `SUPABASE_SERVICE_ROLE_KEY`, otomatis bypass RLS), menutup total akses `anon`/`authenticated` tidak akan merusak fungsi apa pun — asalkan Langkah 2–4 di bawah sudah/akan dikerjakan sebelum policy ini di-deploy ke production. Cek juga RLS tabel `global_settings` dan lakukan hal yang sama untuk key `gemini_shared_keys` bila ditemukan.

### Langkah 2 — Tambah verifikasi identitas di `wa-webhook/index.ts` untuk 4 action non-WA

Untuk setiap handler di bawah ini, tambahkan pengecekan sebelum eksekusi — **tanpa mengubah bentuk response atau logic penyimpanan yang sudah ada**:

1. **`get_gemini_shared_keys`** dan **`admin_update_shared_keys`**
   - Wajibkan header `Authorization: Bearer <access_token>` berisi token sesi Supabase Auth yang valid.
   - Verifikasi token itu (`db.auth.getUser(token)`), lalu cek user tersebut punya flag/role admin di tabel `users` (misal kolom `is_admin = true` — sesuaikan dengan skema yang sudah ada, cek dulu apakah kolom ini sudah ada).
   - Kalau tidak valid / bukan admin → balikin `401`/`403`, jangan proses lebih lanjut.

2. **`user_get_gemini_keys`** dan **`user_update_gemini_keys`**
   - Wajibkan header `Authorization: Bearer <access_token>` berisi token sesi user yang valid.
   - Verifikasi token, ambil `user.id` dari hasil verifikasi (BUKAN dari `payload.userId` yang dikirim client).
   - Ganti semua pemakaian `payload.userId` di dua handler ini dengan `user.id` hasil verifikasi token — supaya user A secara teknis tidak mungkin baca/ubah key milik user B walau tahu/tebak UUID-nya.

Efek ke frontend (`index.html` & `admin-dashboard.html`): request `fetch(...)` ke 4 action ini perlu ditambah header `Authorization` berisi token sesi yang sudah ada dari `db.auth.getSession()` (Supabase client sudah dipakai di kedua file, tinggal disertakan). Tidak ada perubahan pada urutan/langkah yang dilihat user.

### Langkah 3 — Enkripsi key saat disimpan (semua sumber: `token_gemini_user`, `user_settings.gemini_keys`, `user_settings.gemini_shared_keys`, `global_settings`)

- Simpan 1 secret enkripsi (misal `GEMINI_KEY_ENCRYPTION_SECRET`) sebagai Edge Function Secret di Supabase (setara level kerahasiaan dengan `VAPID_PRIVATE_KEY` yang sudah ada).
- Di titik-titik berikut, enkripsi key SEBELUM disimpan ke DB, dan dekripsi SETELAH dibaca dari DB — logic penyimpanan/pembacaan lainnya (kapan disimpan, ke tabel/kolom mana, format array, dst) tetap sama persis:
  - Handler `user_update_gemini_keys` (enkripsi tiap item array sebelum `.upsert()`)
  - Handler `admin_update_shared_keys` (sama)
  - `resolveGeminiApiKeys()` di `wa-webhook/index.ts` (dekripsi setelah `.select()`, sebelum dikirim ke `callGeminiRaw`)
  - Handler `user_get_gemini_keys` (dekripsi sebelum dikirim balik — hanya ke pemilik yang sudah terverifikasi di Langkah 2)
- Boleh pakai `pgsodium`/Supabase Vault kalau sudah tersedia di project, atau AES-GCM manual di Deno pakai secret di atas — pilih yang paling gampang dijaga konsistensinya di semua titik baca/tulis.

### Langkah 4 — Pindahkan pemanggilan Gemini di `index.html` dari browser ke server (proxy)

Ini bagian yang paling menyentuh `index.html`, tapi **tetap hanya soal "di mana key dipakai", bukan soal prompt/model/logic AI**:

1. Buat Edge Function baru, misal `supabase/functions/call-gemini/index.ts`.
2. Pindahkan isi fungsi `callGeminiRaw` dari `index.html` (~14906) ke Edge Function ini **apa adanya** — urutan coba key pribadi dulu baru key bersama, rotasi otomatis saat 429/403/503, fallback antar model (`GEMINI_MODELS`) semua disalin persis, tidak diubah.
3. Sumber `apiKey` di dalam fungsi yang dipindah ini diganti dari parameter/localStorage jadi hasil `resolveGeminiApiKeys()` + dekripsi (pakai ulang fungsi yang sama dari Langkah 3, biar tidak duplikat logic).
4. Di `index.html`, ganti isi fungsi `callGeminiRaw` menjadi 1 `fetch()` ke Edge Function baru ini, kirim `parts`, `temperature`, `responseSchema` apa adanya (parameter yang sudah ada, tidak berubah), sertakan header `Authorization` dengan token sesi user.
5. Semua pemanggil `callGeminiRaw(...)` di tempat lain dalam `index.html` **tidak perlu diubah sama sekali** — mereka tetap manggil fungsi dengan nama & parameter yang sama, hanya isi di dalamnya yang sekarang jadi "kirim ke server" bukan "manggil Gemini langsung".
6. Endpoint baru ini wajib verifikasi token sesi user (sama seperti Langkah 2) sebelum memproses.

### Langkah 5 — Rate limit di endpoint `call-gemini`

- Tambahkan pembatasan jumlah request per user per menit (misal pakai tabel counter sederhana di Supabase, atau Deno KV kalau tersedia).
- Angka limit disesuaikan dengan pola pemakaian normal fitur AI di app (cek dulu rata-rata pemakaian existing sebelum menentukan angka, supaya tidak mengganggu user yang wajar).
- Ini murni proteksi endpoint, tidak menyentuh logic AI sama sekali.

### Langkah 6 — Bersihkan penyimpanan key plaintext di browser

Setelah Langkah 4 aktif dan sudah stabil:
- Di `index.html`: hapus penyimpanan key ASLI di `localStorage` (`fk_user_gemini_keys`) dan variabel `userKeys`/`sharedKeys` di memory — ganti jadi hanya menyimpan status ringkas untuk kebutuhan tampilan (contoh: jumlah key aktif, versi ter-mask `AIza••••1234` yang memang sudah ditampilkan lewat `maskKey()` sekarang).
- Di `admin-dashboard.html`: sama, hapus `localStorage.setItem('fk_admin_shared_keys', ...)` yang menyimpan key asli.
- Tampilan UI (form input, tombol tambah/hapus, daftar key ter-mask) **tidak berubah** — yang berubah cuma browser tidak lagi menyimpan bentuk asli key-nya.

---

## 3. Urutan Pengerjaan yang Disarankan

1. Langkah 1 (RLS `token_gemini_user`) — bisa langsung, dampak besar, resiko kecil
2. Langkah 2 (verifikasi identitas di 4 action) — sebelum ini kelar, jangan deploy Langkah 1 kalau tabel lain masih bergantung ke akses lama
3. Langkah 3 (enkripsi saat simpan) — sekali jalur akses sudah aman (Langkah 2), aman untuk mulai enkripsi
4. Langkah 4 (proxy `call-gemini`) — independen, bisa dikerjakan paralel dengan Langkah 2–3
5. Langkah 5 (rate limit) — setelah Langkah 4 jalan
6. Langkah 6 (bersih-bersih localStorage) — paling akhir, setelah semua di atas terverifikasi stabil

## 4. Checklist Testing (khusus API key, bukan fitur AI-nya)

- [ ] User baru bisa tambah key pribadi lewat Setting, tersimpan (bisa diverifikasi lewat query DB langsung bahwa nilainya terenkripsi, bukan plaintext)
- [ ] User bisa hapus key pribadinya sendiri
- [ ] User A **tidak bisa** baca/hapus key milik user B lewat manipulasi request langsung (uji pakai `userId` orang lain di payload — harus ditolak)
- [ ] Request ke `get_gemini_shared_keys` / `admin_update_shared_keys` tanpa token admin valid → ditolak (401/403)
- [ ] Query langsung ke tabel `token_gemini_user` pakai `anon key` dari luar aplikasi → ditolak RLS
- [ ] Fitur AI di app (transaksi AI, chat, dll) tetap dapat hasil yang sama seperti sebelumnya — hanya pemanggilan Gemini-nya sekarang lewat server, bukan browser (cek Network tab: tidak ada lagi request langsung ke `generativelanguage.googleapis.com` dari browser)
- [ ] Fitur AI lewat WhatsApp tetap berjalan normal (jalur ini dari awal sudah server-side, pastikan tidak ada regresi setelah key mulai dienkripsi)
- [ ] Rotasi otomatis key (saat 1 key kena limit) tetap berfungsi sama seperti sebelumnya

## 5. Rencana Rollback

- Setiap langkah dikerjakan sebagai migration/commit terpisah (sesuai Aturan Wajib version bump di `index.html` yang sudah berlaku untuk project ini) — supaya kalau ada masalah di 1 langkah, bisa di-revert per langkah tanpa mengganggu langkah lain yang sudah stabil.
- Simpan salinan policy RLS lama sebelum Langkah 1 dijalankan, untuk jaga-jaga perlu rollback cepat.
