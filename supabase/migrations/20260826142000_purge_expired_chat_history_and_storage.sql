-- Migration: 20260826142000_purge_expired_chat_history_and_storage.sql
-- Setup pg_net extension, daily pg_cron schedule via Vault authentication,
-- delegating physical file removal to Edge Function Storage API (single source of truth).

-- 1. Pastikan ekstensi pg_net aktif untuk panggilan HTTP ke Edge Function
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Hapus job cron lama jika ada untuk mencegah duplikasi
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-old-chat-history') THEN
    PERFORM cron.unschedule('purge-old-chat-history');
  END IF;
END $$;

-- 3. Jadwalkan cron purge harian jam 03:00 UTC via pg_net & Supabase Vault
-- Secret diambil secara dinamis dari vault.decrypted_secrets tanpa hardcode di file repo
SELECT cron.schedule(
  'purge-old-chat-history',
  '0 3 * * *',
  $$
  DO $cron_job$
  DECLARE
    v_cron_secret TEXT;
  BEGIN
    SELECT decrypted_secret INTO v_cron_secret
    FROM vault.decrypted_secrets
    WHERE name = 'wa_webhook_cron_secret';

    IF v_cron_secret IS NOT NULL AND v_cron_secret <> '' THEN
      PERFORM net.http_post(
        url := 'https://qdoduglbejcazjufvfkf.supabase.co/functions/v1/wa-webhook',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        body := '{"action": "purge_expired_chat_history"}'::jsonb
      );
    END IF;
  END;
  $cron_job$;
  $$
);
