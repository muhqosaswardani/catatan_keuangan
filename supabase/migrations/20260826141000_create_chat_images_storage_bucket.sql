-- Migration: 20260826141000_create_chat_images_storage_bucket.sql
-- Create private storage bucket 'chat-ai-images' and setup RLS policies per-user.

-- 1. Buat bucket 'chat-ai-images' jika belum ada
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-ai-images',
  'chat-ai-images',
  false,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- 2. Hapus policy lama jika ada untuk mencegah duplikasi
DROP POLICY IF EXISTS "Users can insert own chat images" ON storage.objects;
DROP POLICY IF EXISTS "Users can select own chat images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own chat images" ON storage.objects;
DROP POLICY IF EXISTS "Admin has full access to chat images" ON storage.objects;

-- 3. INSERT Policy: User hanya boleh upload foto ke folder wa_{auth.uid()} miliknya
CREATE POLICY "Users can insert own chat images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'chat-ai-images'
  AND (
    (storage.foldername(name))[1] = ('wa_' || auth.uid()::text)
    OR (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- 4. SELECT Policy: User hanya boleh melihat/download foto dari folder wa_{auth.uid()} miliknya
CREATE POLICY "Users can select own chat images"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat-ai-images'
  AND (
    (storage.foldername(name))[1] = ('wa_' || auth.uid()::text)
    OR (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- 5. DELETE Policy: User boleh menghapus foto dari folder wa_{auth.uid()} miliknya
CREATE POLICY "Users can delete own chat images"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'chat-ai-images'
  AND (
    (storage.foldername(name))[1] = ('wa_' || auth.uid()::text)
    OR (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- 6. ADMIN Policy: Admin dapat mengakses seluruh foto di bucket chat-ai-images
CREATE POLICY "Admin has full access to chat images"
ON storage.objects
FOR ALL
TO authenticated
USING (
  bucket_id = 'chat-ai-images'
  AND public.is_admin() = true
)
WITH CHECK (
  bucket_id = 'chat-ai-images'
  AND public.is_admin() = true
);
