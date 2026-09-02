-- Migration: Fix Wallet Initial Balances (Pure SUM Architecture)
-- 1) Dompet Utama Sotya: baseline 5000000 (income, karena positif) dimigrasi ke transaksi "Saldo Awal (Migrasi Sistem)"
-- Menggunakan category_id 'wa_cat_fabddd22bc8f41a5' (kategori Penyesuaian Saldo income milik Sotya)
-- Guard WHERE NOT EXISTS memastikan script idempotent (aman dijalankan ulang)

INSERT INTO transactions (
  id,
  access_code,
  wallet_id,
  category_id,
  category,
  type,
  amount,
  date,
  note,
  source,
  exclude_from_report,
  user_id
)
SELECT
  'migr_saldo_awal_' || w.id,
  w.access_code,
  w.id,
  'wa_cat_fabddd22bc8f41a5',
  'Penyesuaian Saldo',
  'income',
  5000000,
  COALESCE(
    (SELECT MIN(t.date)::date - INTERVAL '1 day' FROM transactions t WHERE t.wallet_id = w.id OR t.to_wallet_id = w.id),
    w.created_at::date
  )::text,
  'Saldo Awal (Migrasi Sistem)',
  'app',
  true,
  w.user_id
FROM wallets w
WHERE w.id = 'wa_w_c79aee13d19345d4'
  AND NOT EXISTS (
    SELECT 1 FROM transactions t WHERE t.id = 'migr_saldo_awal_' || w.id
  );

-- 2) Bersihkan SEMUA initialBalances di semua user_settings
-- Baseline tersembunyi tidak lagi digunakan karena saldo dompet 100% murni SUM(transaksi)
UPDATE user_settings
SET nav_config = nav_config - 'initialBalances'
WHERE nav_config ? 'initialBalances';
