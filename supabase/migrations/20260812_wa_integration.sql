-- Migration: Fase 7 WhatsApp Integration (v2)
-- Jalankan di: https://supabase.com/dashboard/project/qdoduglbejcazjufvfkf/sql/new

-- ─── 1. Kolom 'source' di transactions ──────────────────────────────────────
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'app';

-- ─── 2. Mapping wa_message_id ↔ transaction_id (reply-to-edit/delete) ───────
CREATE TABLE IF NOT EXISTS public.wa_message_transactions (
  wa_message_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  access_code   TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_transaction_id ON public.wa_message_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_access_code    ON public.wa_message_transactions(access_code);

-- ─── 3. Transaksi pending amount=0 (menunggu nominal dari user) ──────────────
CREATE TABLE IF NOT EXISTS public.wa_pending_transactions (
  id                      TEXT PRIMARY KEY,
  access_code             TEXT NOT NULL,
  wa_chat_id              TEXT NOT NULL,
  wa_question_message_id  TEXT,
  pending_data            JSONB NOT NULL,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_pending_access_code ON public.wa_pending_transactions(access_code);
CREATE INDEX IF NOT EXISTS idx_wa_pending_chat_id     ON public.wa_pending_transactions(wa_chat_id);

-- ─── 4. Queue media (foto + VN) untuk batching sebelum dikirim ke Gemini ─────
--       Menggantikan pendekatan in-memory yang tidak bisa cross-instance.
CREATE TABLE IF NOT EXISTS public.wa_media_queue (
  wa_message_id TEXT PRIMARY KEY,
  access_code   TEXT NOT NULL,
  wa_chat_id    TEXT NOT NULL,
  media_id      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'image/jpeg',
  media_kind    TEXT NOT NULL DEFAULT 'image',   -- 'image' | 'audio'
  caption       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 seconds'
);
CREATE INDEX IF NOT EXISTS idx_wa_media_queue_chat_id    ON public.wa_media_queue(wa_chat_id);
CREATE INDEX IF NOT EXISTS idx_wa_media_queue_expires_at ON public.wa_media_queue(expires_at);
CREATE INDEX IF NOT EXISTS idx_wa_media_queue_access     ON public.wa_media_queue(access_code);

-- ─── 5. Idempotency: cegah proses ulang webhook yang terkirim ganda ──────────
CREATE TABLE IF NOT EXISTS public.wa_processed_messages (
  wa_message_id TEXT PRIMARY KEY,
  access_code   TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_proc_access_code ON public.wa_processed_messages(access_code);

-- Opsional: auto-cleanup wa_media_queue dan wa_processed_messages lama.
-- Aktifkan kalau pg_cron tersedia di project ini, atau biarkan Edge Function cleanup saat diakses.
-- SELECT cron.schedule('cleanup-wa-queue', '*/5 * * * *', $$
--   DELETE FROM public.wa_media_queue WHERE expires_at < NOW();
--   DELETE FROM public.wa_processed_messages WHERE created_at < NOW() - INTERVAL '7 days';
-- $$);
