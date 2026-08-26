-- supabase/migrations/20260823_password_setup_flow.sql
-- Migration: Fase 1 - Pisah Alur Daftar & Masuk (Kata Sandi Sendiri)
-- Menambahkan kolom untuk mekanisme "setup token" sekali pakai yang dipakai user
-- untuk membuat kata sandinya sendiri setelah verifikasi WA berhasil, menggantikan
-- password acak otomatis yang sebelumnya dikirim via WhatsApp.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_setup_token TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_setup_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_password_setup_token ON public.users(password_setup_token);
