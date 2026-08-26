-- Migration 2026082501_fix_global_settings_rls.sql
-- Fix RLS policies for global_settings to allow anon and authenticated access

-- 1. Drop incorrect policy that was assigned to public.tokens
DROP POLICY IF EXISTS "Allow authenticated to view global settings" ON public.tokens;
-- 2. Drop existing global_settings policies to avoid conflict
DROP POLICY IF EXISTS "Allow authenticated to view global settings" ON public.global_settings;
DROP POLICY IF EXISTS "Allow authenticated to manage global settings" ON public.global_settings;
DROP POLICY IF EXISTS "Allow select global settings" ON public.global_settings;
DROP POLICY IF EXISTS "Allow manage global settings" ON public.global_settings;
-- 3. Allow anon and authenticated to view global_settings
CREATE POLICY "Allow select global settings" 
ON public.global_settings FOR SELECT 
TO anon, authenticated 
USING (true);
-- 4. Allow anon and authenticated to insert/update global_settings (Admin dashboard)
CREATE POLICY "Allow manage global settings" 
ON public.global_settings FOR ALL 
TO anon, authenticated 
USING (true) 
WITH CHECK (true);
