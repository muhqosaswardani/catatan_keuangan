-- supabase/migrations/20260819_grant_multiuser_permissions.sql
-- Grant permissions on Multi-User tables to all roles

GRANT ALL ON TABLE public.users TO service_role, postgres, anon, authenticated;
GRANT ALL ON TABLE public.verifikasi_wa TO service_role, postgres, anon, authenticated;
GRANT ALL ON TABLE public.tokens TO service_role, postgres, anon, authenticated;
