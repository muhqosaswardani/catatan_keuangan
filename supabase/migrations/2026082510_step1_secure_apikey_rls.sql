-- Migration 2026082510_step1_secure_apikey_rls.sql
-- Langkah 1: Kunci RLS tabel token_gemini_user dan global_settings
-- ⚠️ JANGAN DIJALANKAN sebelum Langkah 2 (verifikasi token di wa-webhook)
--    dan Langkah 4 (proxy call-gemini) sudah live di production.
--    Kalau RLS ini aktif duluan sementara browser masih baca key langsung
--    dari tabel, fitur AI akan error total untuk semua user.

-- ============================================================
-- A. TABEL: token_gemini_user — tutup total akses client
-- ============================================================
DROP POLICY IF EXISTS "Allow all to view own gemini keys"   ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to insert own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to delete own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow authenticated to view own gemini keys"   ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow authenticated to insert own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow authenticated to delete own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Deny all client access to token_gemini_user"   ON public.token_gemini_user;

-- Tutup total: hanya service_role (Edge Function) yang bisa akses via bypass RLS
CREATE POLICY "Deny all client access to token_gemini_user"
  ON public.token_gemini_user
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ============================================================
-- B. TABEL: global_settings — tutup SELECT row sensitif + tutup semua tulis
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated to view global settings"     ON public.global_settings;
DROP POLICY IF EXISTS "Allow authenticated to manage global settings"   ON public.global_settings;
DROP POLICY IF EXISTS "Allow select global settings"                    ON public.global_settings;
DROP POLICY IF EXISTS "Allow manage global settings"                    ON public.global_settings;
DROP POLICY IF EXISTS "Allow anon to view global settings"             ON public.global_settings;
DROP POLICY IF EXISTS "Allow anon to manage global settings"           ON public.global_settings;
DROP POLICY IF EXISTS "Deny write global settings from client"          ON public.global_settings;

-- SELECT boleh untuk row non-sensitif (misal default_trial_days)
-- Row 'gemini_shared_keys' ditutup (key bersama sudah pindah ke user_settings)
CREATE POLICY "Allow select global settings"
  ON public.global_settings
  FOR SELECT
  TO anon, authenticated
  USING (key != 'gemini_shared_keys');

-- INSERT/UPDATE/DELETE dari client ditutup total — hanya service_role
CREATE POLICY "Deny write global settings from client"
  ON public.global_settings
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);
