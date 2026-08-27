-- Migration: 20260827163000_update_chat_images_bucket_audio_mimes.sql
-- Tambahkan MIME type audio ke bucket 'chat-ai-images' untuk fitur Voice Note di chat AI.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav'
]
WHERE id = 'chat-ai-images';
