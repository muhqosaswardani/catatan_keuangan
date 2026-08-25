-- Migration 2026082510_step1_secure_apikey_rls.sql
-- Langkah 1: Kunci RLS tabel user_settings, global_settings, dan tokens
-- ⚠️ JANGAN DIJALANKAN sebelum Langkah 2 (verifikasi token di wa-webhook)
--    dan Langkah 4 (proxy call-gemini) sudah live di production.

-- ============================================================
-- A. TABEL: global_settings — tutup row sensitif & tutup tulis dari client
-- ============================================================
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated to view global settings"     ON public.global_settings;
DROP POLICY IF EXISTS "Allow authenticated to manage global settings"   ON public.global_settings;
DROP POLICY IF EXISTS "Allow select global settings"                    ON public.global_settings;
DROP POLICY IF EXISTS "Allow manage global settings"                    ON public.global_settings;
DROP POLICY IF EXISTS "Allow anon to view global settings"             ON public.global_settings;
DROP POLICY IF EXISTS "Allow anon to manage global settings"           ON public.global_settings;
DROP POLICY IF EXISTS "Deny write global settings from client"          ON public.global_settings;

-- 1. SELECT publik/authenticated diizinkan HANYA untuk row non-sensitif (misal: default_trial_days)
--    Row 'gemini_shared_keys' DITUTUP TOTAL dari client browser (dibaca lewat backend wa-webhook)
CREATE POLICY "Allow select global settings"
  ON public.global_settings
  FOR SELECT
  TO anon, authenticated
  USING (key != 'gemini_shared_keys');

-- 2. INSERT / UPDATE / DELETE dari client browser DITUTUP TOTAL (hanya service_role / backend wa-webhook)
CREATE POLICY "Deny write global settings from client"
  ON public.global_settings
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ============================================================
-- B. TABEL: user_settings — amankan settings dan API key pribadi
-- ============================================================
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "User settings policy" ON public.user_settings;
DROP POLICY IF EXISTS "Users can view own settings" ON public.user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON public.user_settings;
DROP POLICY IF EXISTS "Users can insert own settings" ON public.user_settings;
DROP POLICY IF EXISTS "Deny access to admin shared settings row" ON public.user_settings;

-- 1. User hanya bisa SELECT row miliknya sendiri dan BUKAN row sistem/admin
CREATE POLICY "Users can view own settings"
  ON public.user_settings
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id AND access_code != 'admin_shared_keys');

-- 2. User hanya bisa INSERT row miliknya sendiri
CREATE POLICY "Users can insert own settings"
  ON public.user_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND access_code != 'admin_shared_keys');

-- 3. User hanya bisa UPDATE row miliknya sendiri
CREATE POLICY "Users can update own settings"
  ON public.user_settings
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id AND access_code != 'admin_shared_keys')
  WITH CHECK (auth.uid() = user_id AND access_code != 'admin_shared_keys');

-- ============================================================
-- C. TABEL: tokens (Kode Voucher Aktivasi Akun) — cegah manipulasi client
-- ============================================================
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view token availability" ON public.tokens;
DROP POLICY IF EXISTS "Allow select tokens" ON public.tokens;
DROP POLICY IF EXISTS "Deny write tokens from client" ON public.tokens;

-- 1. Client boleh melihat daftar token jika dibutuhkan UI
CREATE POLICY "Allow select tokens"
  ON public.tokens
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- 2. INSERT / UPDATE / DELETE pada kode token DITUTUP TOTAL dari client browser
--    Seluruh perubahan status & pembuatan token wajib lewat service_role di wa-webhook
CREATE POLICY "Deny write tokens from client"
  ON public.tokens
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "Deny update tokens from client"
  ON public.tokens
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny delete tokens from client"
  ON public.tokens
  FOR DELETE
  TO authenticated, anon
  USING (false);
