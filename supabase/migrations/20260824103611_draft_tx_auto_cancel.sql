-- Fase 2 Bagian 2 (revisi): auto-cancel transaksi draft (is_draft = true, dari
-- "Transaksi AI Cepat" yang nominalnya belum jelas) kalau tidak di-ketuk/dilengkapi
-- user dalam 5 menit sejak dibuat. Row DIHAPUS TOTAL (bukan disimpan dengan nominal 0).

CREATE EXTENSION IF NOT EXISTS pg_cron;

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
    INSERT INTO public.user_settings (access_code, deleted_ids)
    SELECT rec.access_code, '[]'::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_settings WHERE access_code = rec.access_code
    );

    UPDATE public.user_settings
    SET deleted_ids = (
          SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb)
          FROM jsonb_array_elements(
                 COALESCE(deleted_ids, '[]'::jsonb) || to_jsonb(rec.ids::text[])
               ) AS x
        ),
        updated_at = NOW()
    WHERE access_code = rec.access_code;

    DELETE FROM public.transactions
    WHERE access_code = rec.access_code
      AND id = ANY(rec.ids)
      AND is_draft = true;
  END LOOP;
END;
$$;

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
;
