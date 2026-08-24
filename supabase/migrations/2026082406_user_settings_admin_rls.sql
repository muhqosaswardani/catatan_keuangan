-- Migration 2026082406_user_settings_admin_rls.sql
-- Allow authenticated admin users to manage user_settings (for WA Auto-Reply toggle, etc.)

CREATE POLICY "Allow authenticated to view all user_settings"
    ON public.user_settings FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated to update all user_settings"
    ON public.user_settings FOR UPDATE
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated to insert all user_settings"
    ON public.user_settings FOR INSERT
    TO authenticated
    WITH CHECK (true);
