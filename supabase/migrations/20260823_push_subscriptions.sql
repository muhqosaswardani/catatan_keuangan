-- supabase/migrations/20260823_push_subscriptions.sql
-- Fase 2 Bagian 1: Infrastruktur Notifikasi PWA (Web Push)
--
-- CATATAN: tabel ini ternyata sudah ada duluan di database (dibuat di luar
-- migration ini, kemungkinan dari sesi kerja lain sebelum file ini ditulis)
-- dengan kolom `p256dh`/`auth` (bukan `keys_p256dh`/`keys_auth`) dan sudah
-- ada 1 RLS policy "Users manage own push subscriptions". Migration ini
-- disamakan ke skema yang sudah live tsb (idempotent, aman dijalankan ulang).

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_subscriptions_select_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select_own" ON public.push_subscriptions
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "push_subscriptions_insert_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_insert_own" ON public.push_subscriptions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own" ON public.push_subscriptions
    FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, DELETE ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role, postgres;
