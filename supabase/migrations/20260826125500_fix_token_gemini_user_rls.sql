-- Migration: fix_token_gemini_user_rls
-- Target: public.token_gemini_user
-- Purpose: Restrict read, write, delete access to key owner only (authenticated users)

-- 1. Drop existing leaky policies
DROP POLICY IF EXISTS "Allow all to view own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to insert own gemini keys" ON public.token_gemini_user;
DROP POLICY IF EXISTS "Allow all to delete own gemini keys" ON public.token_gemini_user;

-- 2. Make sure RLS is enabled
ALTER TABLE public.token_gemini_user ENABLE ROW LEVEL SECURITY;

-- 3. Create a single ALL policy restricted to owner (auth.uid() = user_id) and role 'authenticated'
CREATE POLICY "User gemini keys policy"
ON public.token_gemini_user
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
