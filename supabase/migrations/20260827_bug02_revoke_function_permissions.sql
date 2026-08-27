-- Migration: 20260827_bug02_revoke_function_permissions.sql
-- BUG-02: Revoke public/anon execute permissions on internal and security-critical functions

-- 1. is_admin(): Revoke from public and anon; grant only to authenticated and internal roles
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role, postgres;

-- 2. cleanup_expired_draft_transactions(): Internal cron maintenance function, revoke from all client roles
REVOKE ALL ON FUNCTION public.cleanup_expired_draft_transactions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_draft_transactions() TO service_role, postgres;
