-- Migration 2026082502_create_token_gemini_user.sql
-- Create table token_gemini_user and add gemini_keys column to user_settings for full cross-device sync

-- 1. Table: public.token_gemini_user
CREATE TABLE IF NOT EXISTS public.token_gemini_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_gemini_user_user_id ON public.token_gemini_user(user_id);

-- 2. Add column to user_settings for backup sync
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS gemini_keys JSONB DEFAULT '[]'::jsonb;

-- 3. Enable RLS on token_gemini_user
ALTER TABLE public.token_gemini_user ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated to view own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to view own gemini keys" ON public.token_gemini_user;
CREATE POLICY "Allow all to view own gemini keys" 
ON public.token_gemini_user FOR SELECT 
TO anon, authenticated 
USING (true);

DROP POLICY IF EXISTS "Allow authenticated to insert own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to insert own gemini keys" ON public.token_gemini_user;
CREATE POLICY "Allow all to insert own gemini keys" 
ON public.token_gemini_user FOR INSERT 
TO anon, authenticated 
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated to delete own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to delete own gemini keys" ON public.token_gemini_user;
CREATE POLICY "Allow all to delete own gemini keys" 
ON public.token_gemini_user FOR DELETE 
TO anon, authenticated 
USING (true);
