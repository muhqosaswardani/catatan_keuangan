-- Fase 2 Bagian 2 (revisi): auto-cancel transaksi draft (is_draft = true, dari
-- "Transaksi AI Cepat" yang nominalnya belum jelas) kalau tidak di-ketuk/dilengkapi
-- user dalam 5 menit sejak dibuat. Row DIHAPUS TOTAL (bukan disimpan dengan nominal 0).
-- Migration manual (bukan auto-CI/CD) — jalankan lewat tab Actions GitHub, workflow
-- deploy-supabase.yml, run_migration: yes. Aman dijalankan berkali-kali (IF NOT EXISTS
-- / OR REPLACE / unschedule-lalu-schedule-ulang).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Kumpulkan & hapus transaksi draft yang sudah lewat 5 menit. Id yang dihapus dicatat
-- ke user_settings.deleted_ids (per access_code) supaya device lain tidak "resurrect"
-- transaksi ini balik lewat mekanisme sync merge yang sudah ada (lihat index.html,
-- fungsi syncAllWithSupabase — deleted_ids sudah jadi sumber kebenaran utk penghapusan
-- lintas device, sama seperti dipakai wa-webhook untuk penghapusan via WA).
CREATE OR REPLACE FUNCTION public.cleanup_expired_draft_transactions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT access_code, array_agg(id) AS ids
    FROM public.transactions
    WHERE is_draft = true
      AND updated_at < NOW() - INTERVAL '5 minutes'
    GROUP BY access_code
  LOOP
    -- Pastikan ada baris user_settings untuk access_code ini
    INSERT INTO public.user_settings (access_code, deleted_ids)
    SELECT rec.access_code, '[]'::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_settings WHERE access_code = rec.access_code
    );

    -- Gabungkan id yang dihapus ke deleted_ids (dedupe)
    UPDATE public.user_settings
    SET deleted_ids = (
          SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb)
          FROM jsonb_array_elements(
                 COALESCE(deleted_ids, '[]'::jsonb) || to_jsonb(rec.ids::text[])
               ) AS x
        ),
        updated_at = NOW()
    WHERE access_code = rec.access_code;

    -- Hapus transaksi draft yang kedaluwarsa
    DELETE FROM public.transactions
    WHERE access_code = rec.access_code
      AND id = ANY(rec.ids)
      AND is_draft = true;
  END LOOP;
END;
$$;

-- Jadwalkan tiap 1 menit. unschedule dulu kalau sudah ada (biar migration idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-draft-transactions') THEN
    PERFORM cron.unschedule('cleanup-expired-draft-transactions');
  END IF;
END $$;

SELECT cron.schedule(
  'cleanup-expired-draft-transactions',
  '* * * * *',
  $$SELECT public.cleanup_expired_draft_transactions();$$
);
