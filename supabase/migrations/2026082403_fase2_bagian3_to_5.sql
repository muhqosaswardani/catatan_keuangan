-- supabase/migrations/20260824_fase2_bagian3_to_5.sql
-- Fase 2 (Bagian 3 - 5): Support Toggle Balasan Otomatis WA & Status AI Locked

-- 1. Toggle Balasan Otomatis WA per-user (default: true / ON)
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS wa_auto_reply BOOLEAN DEFAULT true;
-- 2. Status Fitur AI locked per-user (default: false / tidak terkunci)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS ai_locked BOOLEAN DEFAULT false;
