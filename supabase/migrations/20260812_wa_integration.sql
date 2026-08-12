-- Migration: Fase 7 WhatsApp Integration
-- Run this in Supabase SQL Editor

-- 1. Tambah kolom 'source' di tabel transactions
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'app';

-- 2. Tabel mapping: wa_message_id <-> transaction_id (untuk reply-to-edit/delete)
CREATE TABLE IF NOT EXISTS public.wa_message_transactions (
  wa_message_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  access_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_transaction_id ON public.wa_message_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_access_code ON public.wa_message_transactions(access_code);

-- 3. Tabel penyimpanan sementara transaksi amount=0 (menunggu nominal dari user)
CREATE TABLE IF NOT EXISTS public.wa_pending_transactions (
  id TEXT PRIMARY KEY,
  access_code TEXT NOT NULL,
  wa_chat_id TEXT NOT NULL,
  wa_question_message_id TEXT,
  pending_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_pending_access_code ON public.wa_pending_transactions(access_code);
CREATE INDEX IF NOT EXISTS idx_wa_pending_chat_id ON public.wa_pending_transactions(wa_chat_id);

-- 4. Tabel batching multi-foto (state sementara, TTL pendek)
CREATE TABLE IF NOT EXISTS public.wa_media_batches (
  id TEXT PRIMARY KEY,               -- batch_id, unik per sesi batching
  access_code TEXT NOT NULL,
  wa_chat_id TEXT NOT NULL,
  media_items JSONB NOT NULL DEFAULT '[]',  -- array of {media_id, mime_type, caption}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 seconds'
);

CREATE INDEX IF NOT EXISTS idx_wa_batches_chat_id ON public.wa_media_batches(wa_chat_id);

-- 5. Queue media masuk. Ini membuat batching tetap bekerja walaupun setiap
-- webhook ditangani oleh instance Edge Function yang berbeda.
CREATE TABLE IF NOT EXISTS public.wa_media_queue (
  wa_message_id TEXT PRIMARY KEY,
  access_code TEXT NOT NULL,
  wa_chat_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'audio')),
  caption TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wa_media_queue_ready
  ON public.wa_media_queue(wa_chat_id, received_at)
  WHERE processed_at IS NULL;

-- 6. Idempotensi webhook Meta. Satu message id hanya boleh diproses sekali.
CREATE TABLE IF NOT EXISTS public.wa_processed_messages (
  wa_message_id TEXT PRIMARY KEY,
  access_code TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
