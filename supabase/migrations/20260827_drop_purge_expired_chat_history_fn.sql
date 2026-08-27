-- Migration: 20260827_drop_purge_expired_chat_history_fn.sql
-- Hapus fungsi SQL purge_expired_chat_history() yang sudah tidak dipakai.
-- Cron sekarang memanggil handler di Edge Function wa-webhook secara langsung via pg_net,
-- bukan fungsi SQL ini. Fungsi ini tidak memiliki filter kepemilikan sehingga berbahaya
-- jika bisa dipanggil oleh role 'authenticated'.

DROP FUNCTION IF EXISTS public.purge_expired_chat_history();
