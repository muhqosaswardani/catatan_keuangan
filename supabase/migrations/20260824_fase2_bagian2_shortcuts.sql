-- Fase 2 Bagian 2: App Shortcuts & Transaksi AI Cepat
-- Migration manual (bukan auto-CI/CD) — jalankan lewat tab Actions GitHub, workflow
-- deploy-supabase.yml, run_migration: yes. Aman dijalankan berkali-kali (IF NOT EXISTS).

-- Tandai transaksi hasil "Transaksi AI Cepat" yang nominalnya belum jelas dari AI
-- (butuh dilengkapi user lewat notifikasi "Lengkapi" / kartu hasil di layar).
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT false;
-- Snapshot transaksi terakhir yang dihapus lewat tombol "Hapus" di notifikasi push
-- (dieksekusi Service Worker tanpa membuka app). Dipakai index.html untuk menawarkan
-- "Undo" saat app dibuka lagi. Diisi ulang (overwrite) tiap ada penghapusan baru dari
-- notifikasi, dan dikosongkan (null) setelah di-undo atau kedaluwarsa (>24 jam).
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS last_notif_deleted JSONB;
