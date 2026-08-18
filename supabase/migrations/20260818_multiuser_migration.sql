-- supabase/migrations/20260818_multiuser_migration.sql
-- Migration: Multi-User Support (Fase 1)
-- Creates users, verifikasi_wa, and tokens tables, migrates data, and configures RLS.

-- 1. Create public.users table
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nama TEXT NOT NULL,
    nomor_wa TEXT UNIQUE NOT NULL,
    status_verifikasi TEXT DEFAULT 'pending' CHECK (status_verifikasi IN ('pending', 'verified')),
    trial_mulai_at TIMESTAMPTZ,
    trial_lama_hari INT DEFAULT 7,
    token_dipakai TEXT,
    sumber_ai TEXT DEFAULT 'gratis' CHECK (sumber_ai IN ('gratis', 'sendiri')),
    balasan_otomatis_wa BOOLEAN DEFAULT true,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create public.verifikasi_wa table
CREATE TABLE IF NOT EXISTS public.verifikasi_wa (
    kode TEXT PRIMARY KEY, -- 20-character unique verification code
    nomor_wa TEXT NOT NULL,
    password_temp TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes')
);

-- 3. Create public.tokens table
CREATE TABLE IF NOT EXISTS public.tokens (
    code TEXT PRIMARY KEY, -- 8-character token code
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'used')),
    used_by TEXT, -- nomor_wa or user_id
    created_at TIMESTAMPTZ DEFAULT NOW(),
    used_at TIMESTAMPTZ
);

-- 4. Enable RLS on new tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verifikasi_wa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

-- 5. Lockdown public.verifikasi_wa (No public/authenticated access policies)
-- By leaving no policies on public.verifikasi_wa, only the service role key can read/write to it.

-- 6. Add RLS Policies for public.users
CREATE POLICY "Users can view their own profile"
    ON public.users FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
    ON public.users FOR UPDATE
    USING (auth.uid() = id);

-- 7. Add RLS Policies for public.tokens
CREATE POLICY "Anyone can view token availability"
    ON public.tokens FOR SELECT
    USING (true);

-- 8. Add user_id column to existing tables for RLS scoping (keeping access_code for rollback fallback)
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.recurring_items ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.savings_goals ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.debt_entries ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.wa_message_transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.wa_pending_transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.wa_media_queue ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.wa_processed_messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.wa_mode_sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;

-- 9. Add indexes for user_id to ensure fast queries
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON public.categories(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON public.budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_user_id ON public.recurring_items(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON public.savings_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_debts_user_id ON public.debt_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_mode_sessions_user_id ON public.wa_mode_sessions(user_id);

-- 10. Configure RLS on existing tables (Enable and add policy if not present)
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.savings_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_message_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_pending_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_media_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_processed_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_mode_sessions ENABLE ROW LEVEL SECURITY;

-- Dynamic Policy Creator Helpers (DROP first to prevent duplication)
DROP POLICY IF EXISTS "User wallets policy" ON public.wallets;
CREATE POLICY "User wallets policy" ON public.wallets USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User transactions policy" ON public.transactions;
CREATE POLICY "User transactions policy" ON public.transactions USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User categories policy" ON public.categories;
CREATE POLICY "User categories policy" ON public.categories USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User budgets policy" ON public.budgets;
CREATE POLICY "User budgets policy" ON public.budgets USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User recurring items policy" ON public.recurring_items;
CREATE POLICY "User recurring items policy" ON public.recurring_items USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User savings goals policy" ON public.savings_goals;
CREATE POLICY "User savings goals policy" ON public.savings_goals USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User debt entries policy" ON public.debt_entries;
CREATE POLICY "User debt entries policy" ON public.debt_entries USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User settings policy" ON public.user_settings;
CREATE POLICY "User settings policy" ON public.user_settings USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User wa_mode_sessions policy" ON public.wa_mode_sessions;
CREATE POLICY "User wa_mode_sessions policy" ON public.wa_mode_sessions USING (auth.uid() = user_id);

-- 11. Create admin user in auth.users & public.users, and link legacy 'ak_jc3lbk4' data to them.
DO $$
DECLARE
    admin_uuid UUID := 'da7b12d5-e9df-46cc-a4ba-f3a748c08412'; -- Dedicated static UUID for admin
    admin_phone TEXT := '6289626112023'; -- Admin's normalized phone number
    admin_email TEXT := '6289626112023@kaslyai.local';
BEGIN
    -- Check if auth user exists, if not create one with dummy encrypted password
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = admin_uuid OR email = admin_email) THEN
        INSERT INTO auth.users (
            id,
            instance_id,
            email,
            encrypted_password,
            email_confirmed_at,
            created_at,
            updated_at,
            role,
            aud,
            raw_app_meta_data,
            raw_user_meta_data
        ) VALUES (
            admin_uuid,
            '00000000-0000-0000-0000-000000000000',
            admin_email,
            -- Bcrypt hash for a dummy password. The Edge function will update it securely upon first WA verification.
            '$2a$10$T6x8s35B4467oI7Zjm.QOesMv2u.YotT9lgV7JFqHY7IZW0HgwMeq', 
            NOW(),
            NOW(),
            NOW(),
            'authenticated',
            'authenticated',
            '{"provider": "email", "providers": ["email"]}',
            '{}'
        );
    END IF;

    -- Ensure public.users entry for the admin exists
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = admin_uuid) THEN
        INSERT INTO public.users (
            id,
            nama,
            nomor_wa,
            status_verifikasi,
            is_admin,
            sumber_ai,
            trial_mulai_at
        ) VALUES (
            admin_uuid,
            'Muhamad Qosas (Admin)',
            admin_phone,
            'verified',
            true,
            'gratis',
            NOW()
        );
    END IF;

    -- Migrate existing data (matched by legacy access_code = 'ak_jc3lbk4') to the new admin user
    UPDATE public.wallets SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.transactions SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.categories SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.budgets SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.recurring_items SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.savings_goals SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.debt_entries SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.user_settings SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.wa_message_transactions SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.wa_pending_transactions SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.wa_media_queue SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.wa_processed_messages SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;
    UPDATE public.wa_mode_sessions SET user_id = admin_uuid WHERE access_code = 'ak_jc3lbk4' AND user_id IS NULL;

END $$;
