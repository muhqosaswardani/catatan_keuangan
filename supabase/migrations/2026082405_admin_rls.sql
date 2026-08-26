-- Migration 2026082405_admin_rls.sql
-- Allow authenticated admin & users to view user list in Admin Dashboard

CREATE POLICY "Allow authenticated to view all users"
    ON public.users FOR SELECT
    TO authenticated
    USING (true);
CREATE POLICY "Allow authenticated to update all users"
    ON public.users FOR UPDATE
    TO authenticated
    USING (true);
CREATE POLICY "Allow authenticated to delete users"
    ON public.users FOR DELETE
    TO authenticated
    USING (true);
