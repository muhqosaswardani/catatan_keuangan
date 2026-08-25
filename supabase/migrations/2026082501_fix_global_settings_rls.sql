-- Migration 2026082501_fix_global_settings_rls.sql
-- Fix RLS policy typo for global_settings and grant proper manage permissions

-- 1. Drop incorrect policy that was assigned to public.tokens
DROP POLICY IF EXISTS "Allow authenticated to view global settings" ON public.tokens;

-- 2. Allow authenticated users to view global_settings
CREATE POLICY "Allow authenticated to view global settings" 
ON public.global_settings FOR SELECT 
TO authenticated 
USING (true);

-- 3. Allow authenticated users to insert/update global_settings (Admin dashboard)
CREATE POLICY "Allow authenticated to manage global settings" 
ON public.global_settings FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);
