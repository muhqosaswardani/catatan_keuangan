-- Migration: 20260826140000_fix_admin_delete_user.sql
-- Fix BUG-01: Add admin guard via public.is_admin(), correct table names, and restrict execution grants.

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_access_code TEXT := 'wa_' || target_user_id::text;
BEGIN
  -- 0. Guard: Hanya admin atau service_role / postgres yang boleh menjalankan fungsi ini
  IF current_user NOT IN ('service_role', 'postgres') THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Access Denied: Hanya Administrator yang berhak menghapus akun pengguna.';
    END IF;
  END IF;

  -- 1. Unlink & reset status token aktivasi jika user pernah memakai token
  UPDATE public.tokens
  SET status = 'available', used_by = NULL, used_at = NULL
  WHERE used_by = target_user_id;

  -- 2. Hapus data operasional WhatsApp
  DELETE FROM public.wa_message_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_pending_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_media_queue WHERE user_id = target_user_id;
  DELETE FROM public.wa_mode_sessions WHERE user_id = target_user_id;
  DELETE FROM public.wa_logs WHERE user_id = target_user_id;

  -- 3. Hapus data transaksi & master data pengguna
  DELETE FROM public.transactions WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.categories WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.wallets WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.budgets WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.savings_goals WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.debt_entries WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.user_settings WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.push_subscriptions WHERE user_id = target_user_id;

  -- Catatan: Pembersihan file fisik di storage.buckets ('chat-ai-images') dijalankan
  -- via Storage API di Edge Function wa-webhook sebelum memanggil penghapusan baris data.

  -- 4. Hapus dari tabel public.users
  DELETE FROM public.users WHERE id = target_user_id;

  -- 5. Hapus dari tabel auth.users
  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;

-- Revoke all permissions from PUBLIC & anon to prevent unauthorized calls
REVOKE ALL ON FUNCTION public.admin_delete_user(UUID) FROM PUBLIC, anon;

-- Grant EXECUTE to authenticated (protected by is_admin() guard), service_role, and postgres
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated, service_role, postgres;
