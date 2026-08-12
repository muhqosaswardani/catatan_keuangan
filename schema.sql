-- SQL Schema Script for Catatan Keuangan (Supabase)

-- 1. Wallets
CREATE TABLE IF NOT EXISTS public.wallets (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    name TEXT NOT NULL,
    balance NUMERIC DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Transactions
CREATE TABLE IF NOT EXISTS public.transactions (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    wallet_id TEXT,
    category_id TEXT,
    category TEXT,
    type TEXT NOT NULL, -- 'income', 'expense', 'transfer'
    amount NUMERIC DEFAULT 0,
    date TEXT,
    note TEXT,
    to_wallet_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Categories
CREATE TABLE IF NOT EXISTS public.categories (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'expense', 'income'
    icon TEXT,
    color TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Budgets
CREATE TABLE IF NOT EXISTS public.budgets (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    category_id TEXT NOT NULL,
    month TEXT NOT NULL, -- 'YYYY-MM'
    limit_amount NUMERIC DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Recurring Items
CREATE TABLE IF NOT EXISTS public.recurring_items (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    amount NUMERIC DEFAULT 0,
    wallet_id TEXT,
    category_id TEXT,
    day_of_month INT,
    active BOOLEAN DEFAULT TRUE,
    last_confirmed_date TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Savings Goals
CREATE TABLE IF NOT EXISTS public.savings_goals (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    name TEXT NOT NULL,
    target_amount NUMERIC DEFAULT 0,
    wallet_id TEXT,
    target_date TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Debt Entries
CREATE TABLE IF NOT EXISTS public.debt_entries (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    person_name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'i_owe', 'owed_to_me'
    amount NUMERIC DEFAULT 0,
    date TEXT,
    note TEXT,
    due_date TEXT,
    status TEXT DEFAULT 'active', -- 'active', 'paid'
    payoff_wallet_id TEXT,
    payoff_date TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. User Settings & Nav Config
CREATE TABLE IF NOT EXISTS public.user_settings (
    access_code TEXT PRIMARY KEY,
    sheets_web_app_url TEXT,
    nav_config JSONB,
    shortcut_overrides JSONB,
    insight_cache JSONB,
    analysis_cache JSONB,
    onboarded BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexing access_code for fast querying
CREATE INDEX IF NOT EXISTS idx_wallets_access_code ON public.wallets(access_code);
CREATE INDEX IF NOT EXISTS idx_transactions_access_code ON public.transactions(access_code);
CREATE INDEX IF NOT EXISTS idx_categories_access_code ON public.categories(access_code);
CREATE INDEX IF NOT EXISTS idx_budgets_access_code ON public.budgets(access_code);
CREATE INDEX IF NOT EXISTS idx_recurring_access_code ON public.recurring_items(access_code);
CREATE INDEX IF NOT EXISTS idx_goals_access_code ON public.savings_goals(access_code);
CREATE INDEX IF NOT EXISTS idx_debts_access_code ON public.debt_entries(access_code);

-- ============================================================
-- Fase 7: WhatsApp Integration (tambahan)
-- ============================================================

-- Kolom 'source' di transactions: 'app' (default) atau 'whatsapp'
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'app';

-- 9. Mapping wa_message_id <-> transaction_id (untuk reply-to-edit/delete)
CREATE TABLE IF NOT EXISTS public.wa_message_transactions (
    wa_message_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    access_code TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_transaction_id ON public.wa_message_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_tx_access_code ON public.wa_message_transactions(access_code);

-- 10. Penyimpanan sementara transaksi amount=0 (menunggu nominal)
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

-- 11. Batching multi-foto (state sementara, TTL 30 detik)
CREATE TABLE IF NOT EXISTS public.wa_media_batches (
    id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    wa_chat_id TEXT NOT NULL,
    media_items JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 seconds'
);

CREATE INDEX IF NOT EXISTS idx_wa_batches_chat_id ON public.wa_media_batches(wa_chat_id);

-- 12. Queue media masuk untuk batching foto/voice note lintas invocation Edge Function
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

-- 13. Idempotensi webhook Meta
CREATE TABLE IF NOT EXISTS public.wa_processed_messages (
    wa_message_id TEXT PRIMARY KEY,
    access_code TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
