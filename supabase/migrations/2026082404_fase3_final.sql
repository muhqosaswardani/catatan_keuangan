-- Migration 2026082404_fase3_final.sql
-- Fase 3: Trial, Tokens, Global Settings, & Account Deletion CASCADE support

-- 1. Table: public.tokens
CREATE TABLE IF NOT EXISTS public.tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    duration_days INT NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'available', -- 'available', 'used'
    used_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_tokens_code ON public.tokens(code);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON public.tokens(status);

-- 2. Table: public.global_settings
CREATE TABLE IF NOT EXISTS public.global_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default global settings if not exists
INSERT INTO public.global_settings (key, value)
VALUES 
    ('default_trial_days', '7'::jsonb),
    ('gemini_shared_keys', '[]'::jsonb),
    ('admin_private_keys', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 3. Enhance public.users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trial_mulai_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trial_lama_hari INT DEFAULT 7;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS token_dipakai TEXT REFERENCES public.tokens(code) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW();

-- Enable RLS
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to view & redeem tokens
CREATE POLICY "Allow authenticated to view available tokens" 
ON public.tokens FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Allow authenticated to update token redemption" 
ON public.tokens FOR UPDATE 
TO authenticated 
USING (status = 'available');

-- Allow authenticated users to view global_settings
CREATE POLICY "Allow authenticated to view global settings" 
ON public.tokens FOR SELECT 
TO authenticated 
USING (true);

-- Function for permanent account deletion with full cascade
CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete all related user data
  DELETE FROM public.wa_message_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_pending_transactions WHERE user_id = target_user_id;
  DELETE FROM public.wa_media_queue WHERE user_id = target_user_id;
  DELETE FROM public.wa_sessions WHERE user_id = target_user_id;
  DELETE FROM public.wa_logs WHERE user_id = target_user_id;
  DELETE FROM public.transactions WHERE user_id = target_user_id;
  DELETE FROM public.categories WHERE user_id = target_user_id;
  DELETE FROM public.wallets WHERE user_id = target_user_id;
  DELETE FROM public.budgets WHERE user_id = target_user_id;
  DELETE FROM public.savings_goals WHERE user_id = target_user_id;
  DELETE FROM public.debts WHERE user_id = target_user_id;
  DELETE FROM public.user_settings WHERE user_id = target_user_id;
  DELETE FROM public.push_subscriptions WHERE user_id = target_user_id;
  DELETE FROM public.users WHERE id = target_user_id;
END;
$$;
