-- supabase/migrations/20260816_redesign_wallets.sql
-- Migration: Redesign Wallets (Add is_primary, sort_order, created_at, and cek_wallet_scope)

-- 1. Add columns to public.wallets
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false;
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Populate created_at from updated_at for existing records if null
UPDATE public.wallets SET created_at = updated_at WHERE created_at IS NULL;

-- 3. Add cek_wallet_scope to public.user_settings
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS cek_wallet_scope JSONB;

-- 4. Migrate existing wallets data
UPDATE public.wallets SET is_primary = true, sort_order = 0 WHERE id = 'wallet_utama';
UPDATE public.wallets SET is_primary = false, sort_order = 1 WHERE id = 'wallet_tabungan';

-- For any other wallets that might exist, assign sequential sort_orders starting from 2, ordered by created_at ASC
WITH ordered_wallets AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) + 1 as seq
  FROM public.wallets
  WHERE id NOT IN ('wallet_utama', 'wallet_tabungan')
)
UPDATE public.wallets w
SET is_primary = false, sort_order = o.seq
FROM ordered_wallets o
WHERE w.id = o.id;

-- 5. Clean up orphaned records to prevent foreign key constraint violations
DELETE FROM public.savings_goals WHERE wallet_id NOT IN (SELECT id FROM public.wallets);
DELETE FROM public.debt_entries WHERE payoff_wallet_id IS NOT NULL AND payoff_wallet_id NOT IN (SELECT id FROM public.wallets);
DELETE FROM public.recurring_items WHERE wallet_id NOT IN (SELECT id FROM public.wallets);

-- 6. Add physical Foreign Key constraints with ON DELETE CASCADE for goals, recurring, and debt payoffs
ALTER TABLE public.savings_goals DROP CONSTRAINT IF EXISTS fk_savings_goals_wallet;
ALTER TABLE public.savings_goals 
  ADD CONSTRAINT fk_savings_goals_wallet 
  FOREIGN KEY (wallet_id) 
  REFERENCES public.wallets(id) 
  ON DELETE CASCADE;

ALTER TABLE public.debt_entries DROP CONSTRAINT IF EXISTS fk_debt_entries_payoff_wallet;
ALTER TABLE public.debt_entries 
  ADD CONSTRAINT fk_debt_entries_payoff_wallet 
  FOREIGN KEY (payoff_wallet_id) 
  REFERENCES public.wallets(id) 
  ON DELETE CASCADE;

ALTER TABLE public.recurring_items DROP CONSTRAINT IF EXISTS fk_recurring_items_wallet;
ALTER TABLE public.recurring_items 
  ADD CONSTRAINT fk_recurring_items_wallet 
  FOREIGN KEY (wallet_id) 
  REFERENCES public.wallets(id) 
  ON DELETE CASCADE;
