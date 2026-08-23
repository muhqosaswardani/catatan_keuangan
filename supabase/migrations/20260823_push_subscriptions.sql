-- supabase/migrations/20260823_push_subscriptions.sql
-- Fase 2 Bagian 1: Infrastruktur Notifikasi PWA (Web Push)

-- 1. Tabel push_subscriptions: satu baris per device per user
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions(user_id);

-- 2. RLS: user hanya boleh akses baris miliknya sendiri (auth.uid())
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

-- Tidak ada UPDATE policy: kalau device resubscribe (endpoint/keys berubah),
-- frontend hapus baris lama lalu insert baris baru, jadi tidak butuh UPDATE.

-- 3. Grant dasar ke authenticated (RLS di atas yang membatasi baris mana yang kelihatan)
GRANT SELECT, INSERT, DELETE ON TABLE public.push_subscriptions TO authenticated;
-- service_role dipakai Edge Function internal (send-push-notification) untuk baca semua subscription
GRANT ALL ON TABLE public.push_subscriptions TO service_role, postgres;
