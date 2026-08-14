-- Migration: WhatsApp Integration Stage 2 (Fase 8)
-- Table for managing locked mode state sessions

CREATE TABLE IF NOT EXISTS public.wa_mode_sessions (
    wa_chat_id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    mode TEXT, -- 'koreksi', 'limit', 'tujuan'
    session_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_sessions_access ON public.wa_mode_sessions(access_code);
