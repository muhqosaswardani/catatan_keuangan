-- Migration: 20260826142000_purge_expired_chat_history_and_storage.sql
-- Function to purge chatHistory older than 60 days from user_settings.nav_config,
-- cleaning up Storage objects FIRST before updating JSON to prevent orphan files.

CREATE OR REPLACE FUNCTION public.purge_expired_chat_history()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  v_cutoff_ms BIGINT;
  v_row RECORD;
  v_chat_arr JSONB;
  v_kept_arr JSONB;
  v_item JSONB;
  v_img_path TEXT;
  v_deleted_files_count INT := 0;
  v_purged_msgs_count INT := 0;
  v_affected_users INT := 0;
BEGIN
  -- Batas 60 hari yang lalu dalam milidetik (epoch ms)
  v_cutoff_ms := (EXTRACT(EPOCH FROM (NOW() - INTERVAL '60 days')) * 1000)::BIGINT;

  FOR v_row IN
    SELECT user_id, access_code, nav_config
    FROM public.user_settings
    WHERE nav_config IS NOT NULL
      AND jsonb_typeof(nav_config->'chatHistory') = 'array'
      AND jsonb_array_length(nav_config->'chatHistory') > 0
  LOOP
    v_chat_arr := v_row.nav_config->'chatHistory';
    v_kept_arr := '[]'::JSONB;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_chat_arr)
    LOOP
      IF (v_item->>'timestamp') IS NOT NULL AND (v_item->>'timestamp')::BIGINT < v_cutoff_ms THEN
        -- Pesan ini sudah lewat 60 hari -> bersihkan
        v_purged_msgs_count := v_purged_msgs_count + 1;
        v_img_path := v_item->>'image';

        -- Jika memiliki path Storage (bukan data URL base64), hapus filenya dari storage.objects
        IF v_img_path IS NOT NULL AND v_img_path <> '' AND NOT (v_img_path LIKE 'data:%') THEN
          -- Bersihkan prefix bucket name jika tersimpan lengkap
          v_img_path := regexp_replace(v_img_path, '^chat-ai-images/', '');

          DELETE FROM storage.objects
          WHERE bucket_id = 'chat-ai-images'
            AND name = v_img_path;

          IF FOUND THEN
            v_deleted_files_count := v_deleted_files_count + 1;
          END IF;
        END IF;
      ELSE
        -- Pesan masih aktif (<= 60 hari), pertahankan
        v_kept_arr := v_kept_arr || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    -- Jika ada pesan yang dipurge, update nav_config
    IF jsonb_array_length(v_kept_arr) < jsonb_array_length(v_chat_arr) THEN
      IF v_row.user_id IS NOT NULL THEN
        UPDATE public.user_settings
        SET nav_config = jsonb_set(nav_config, '{chatHistory}', v_kept_arr)
        WHERE user_id = v_row.user_id;
      ELSE
        UPDATE public.user_settings
        SET nav_config = jsonb_set(nav_config, '{chatHistory}', v_kept_arr)
        WHERE access_code = v_row.access_code;
      END IF;

      v_affected_users := v_affected_users + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'purged_messages', v_purged_msgs_count,
    'deleted_storage_files', v_deleted_files_count,
    'affected_users', v_affected_users,
    'cutoff_timestamp', v_cutoff_ms
  );
END;
$$;

-- Grant EXECUTE to service_role, postgres, and authenticated
REVOKE ALL ON FUNCTION public.purge_expired_chat_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_chat_history() TO service_role, postgres, authenticated;
