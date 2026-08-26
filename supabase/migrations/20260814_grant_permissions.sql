-- supabase/migrations/20260814_grant_permissions.sql
-- Grant full permissions on V2 tables to all client roles to resolve permission denied issues.

GRANT ALL ON TABLE public.wa_mode_sessions TO service_role, postgres, anon, authenticated;
GRANT ALL ON TABLE public.wa_logs TO service_role, postgres, anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role, postgres, anon, authenticated;
