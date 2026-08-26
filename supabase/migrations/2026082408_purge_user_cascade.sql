-- supabase/migrations/2026082408_purge_user_cascade.sql
-- Function for 100% clean permanent account deletion (purge all transactions, settings, and auth.users entry)

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_access_code TEXT := 'wa_' || target_user_id::text;
BEGIN
  -- 1. Unlink & reset token status if this user used any token
  UPDATE public.tokens
  SET status = 'available', used_by = NULL, used_at = NULL
  WHERE used_by = target_user_id;

  -- 2. Delete all related operational & transactional data (matching user_id or access_code)
  DELETE FROM public.wa_message_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_pending_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_media_queue WHERE user_id = target_user_id;
  DELETE FROM public.wa_sessions WHERE user_id = target_user_id;
  DELETE FROM public.wa_logs WHERE user_id = target_user_id;

  DELETE FROM public.transactions WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.categories WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.wallets WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.budgets WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.savings_goals WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.debts WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.user_settings WHERE user_id = target_user_id OR access_code = v_access_code;
  DELETE FROM public.push_subscriptions WHERE user_id = target_user_id;

  -- 3. Delete from public.users table
  DELETE FROM public.users WHERE id = target_user_id;

  -- 4. Delete from auth.users table (allowing user to register again as brand new user)
  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO service_role, postgres, authenticated;
