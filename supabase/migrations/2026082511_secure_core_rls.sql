-- Migration 2026082511_secure_core_rls.sql
-- Penutupan Celah RLS: users, user_settings, tokens

-- ============================================================
-- 1. Helper Function: is_admin() (SECURITY DEFINER)
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND is_admin = true
  );
$$;

-- ============================================================
-- 2. Trigger Anti Self-Privilege Escalation pada public.users
--    (Menggunakan auth.role() agar akurat di dalam SECURITY DEFINER)
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_client_is_admin_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Tolak modifikasi kolom is_admin jika pemanggil adalah client (authenticated / anon)
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin AND auth.role() IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Kolom is_admin hanya dapat diubah melalui sistem internal backend.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_client_is_admin_update ON public.users;
CREATE TRIGGER trg_prevent_client_is_admin_update
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_client_is_admin_update();

-- ============================================================
-- 3. Dynamic Drop: Bersihkan 100% Policy Aktif di pg_policies
-- ============================================================
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT policyname, tablename
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('users', 'user_settings', 'tokens')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
    END LOOP;
END $$;

-- ============================================================
-- 4. Tabel public.users — RLS Ketat
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- User baca miliknya sendiri ATAU Admin baca semua
CREATE POLICY "Users can view own or admin all"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id OR public.is_admin() = true);

-- User update miliknya sendiri ATAU Admin update user lain
CREATE POLICY "Users can update own or admin all"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id OR public.is_admin() = true)
  WITH CHECK (auth.uid() = id OR public.is_admin() = true);

-- HANYA Admin yang boleh delete user
CREATE POLICY "Admin can delete users"
  ON public.users
  FOR DELETE
  TO authenticated
  USING (public.is_admin() = true);

-- ============================================================
-- 5. Tabel public.user_settings — RLS Ketat
-- ============================================================
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: Milik sendiri ATAU Admin (kecuali row rahasia admin_shared_keys)
CREATE POLICY "Users view own or admin all settings"
  ON public.user_settings
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid() = user_id OR public.is_admin() = true)
    AND access_code != 'admin_shared_keys'
  );

-- INSERT: Milik sendiri ATAU Admin
CREATE POLICY "Users insert own or admin all settings"
  ON public.user_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.uid() = user_id OR public.is_admin() = true)
    AND access_code != 'admin_shared_keys'
  );

-- UPDATE: Milik sendiri ATAU Admin
CREATE POLICY "Users update own or admin all settings"
  ON public.user_settings
  FOR UPDATE
  TO authenticated
  USING (
    (auth.uid() = user_id OR public.is_admin() = true)
    AND access_code != 'admin_shared_keys'
  )
  WITH CHECK (
    (auth.uid() = user_id OR public.is_admin() = true)
    AND access_code != 'admin_shared_keys'
  );

-- ============================================================
-- 6. Tabel public.tokens — Tutup Total dari Client
-- ============================================================
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

-- Tutup total client access: Seluruh transaksi token HANYA lewat wa-webhook (service_role)
CREATE POLICY "Deny all client access to tokens"
  ON public.tokens
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);
