CREATE UNIQUE INDEX IF NOT EXISTS idx_one_primary_wallet_per_user
ON public.wallets (user_id)
WHERE is_primary = true;;
