# Addendum — Revisi BUG-03c (Migrasi Foto Chat ke Supabase Storage)

**Berdasarkan verifikasi live query ke database production `qdoduglbejcazjufvfkf`, 26 Agustus 2026.**
Lampirkan file ini setelah BUG-03 di `BUGFIX-catatan-keuangan-2026-08-26.md` sebelum diberikan ke Antigravity IDE.

---

## Temuan tambahan BUG-01 (sebelum lanjut ke BUG-03)

Definisi live `admin_delete_user` dicek langsung: benar tanpa guard `is_admin()` internal, dan grant-nya `PUBLIC:EXECUTE` (lebih luas dari anon/authenticated saja). Selain fix di MD asli, function ini juga mereferensikan tabel yang **tidak ada di schema**: `wa_sessions` dan `debts` (nama sebenarnya `wa_mode_sessions` dan `debt_entries`). Tambahkan ke task BUG-01: perbaiki nama tabel yang salah ini juga saat menambahkan guard — kalau tidak, statement `DELETE FROM public.wa_sessions` akan tetap error terus meski guard sudah dipasang.

---

## Kenapa BUG-03c versi asli belum cukup

Tujuan akhirnya: **memaksimalkan penghematan penyimpanan Supabase**, bukan cuma memindah lokasi bengkaknya. MD asli baru menutup sebagian jalur. Tiga lubang berikut, kalau dilewatkan, bikin masalah yang sama persis pindah tempat — bukan hilang:

### 1. Bucket Storage belum ada
Live check: `storage.buckets` = 0 baris di project ini. Belum ada satu bucket pun dibuat. Task tambahan untuk Antigravity IDE:
```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-ai-images', 'chat-ai-images', false, 10485760, array['image/jpeg','image/png','image/webp']);
```
- **Bucket harus privat** (`public: false`) — isinya foto struk/nota transaksi pribadi, bukan konten publik.
- Buat RLS policy di `storage.objects` yang scoped per user, pakai konvensi path `{access_code}/{msg_id}.ext` supaya policy bisa cocokkan folder ke pemilik data (pola yang sama seperti RLS tabel lain di project ini).

### 2. Backfill 8 foto lama yang sudah base64
BUG-03c versi asli cuma pasang logic upload untuk foto **baru** ke depan. Live query nemu 8 item dari 261 chatHistory yang masih base64 (di user `wa_da7b12d5...`). Kalau tidak dibackfill, ke-8 item ini tetap membebani `nav_config` sampai umurnya lewat 60 hari dan ke-purge cron — kebetulan aman untuk kasus ini karena datanya lama, tapi tidak general untuk foto baru yang dikirim user lain dalam 60 hari terakhir sebelum fix 3c terpasang.

**Task tambahan (jalankan sekali, bareng BUG-03a, SEBELUM purge JSON):**
1. Extract base64 dari 8 item existing.
2. Upload masing-masing ke bucket `chat-ai-images`.
3. Replace field `image` di JSON dari base64 string jadi path Storage.

### 3. Cron 60-hari (BUG-03b) harus ikut hapus file Storage, bukan cuma opsional
MD asli taruh ini di bagian "Rekomendasi tambahan (opsional)" — padahal ini **wajib**, karena inilah yang benar-benar menjawab kekhawatiran Anda: kalau file Storage tidak ikut dihapus saat entry JSON-nya dipurge, foto tetap numpuk selamanya di Storage, cuma pindah dari kolom `nav_config` ke bucket.

**Urutan yang benar di dalam cron job:**
1. Kumpulkan dulu semua path Storage dari item chatHistory yang timestamp-nya sudah lewat 60 hari (`item->>'image'`, yang sekarang formatnya path bukan base64).
2. Hapus object-object itu dari `storage.objects` / lewat Storage API.
3. Baru jalankan `UPDATE ... SET nav_config = jsonb_set(...)` untuk membuang entrinya dari JSON.

Kalau urutan dibalik (JSON dihapus duluan), path filenya hilang duluan sebelum sempat dipakai untuk hapus file Storage-nya → jadi orphan file yang tidak pernah ke-cleanup.

### 4. Render foto di chat perlu logic baru (tidak bisa "zero perubahan logic")
Karena bucket privat, front-end wajib generate **signed URL** (expiring, mis. 1 jam) tiap kali menampilkan riwayat chat, gantikan `<img src="data:base64...">` yang dipakai sekarang. Ini satu-satunya bagian yang logic-nya berubah — dan perubahannya terbatas hanya di fungsi render gambar chat "Tambah via AI". Fitur lain (dompet, transaksi, kategori, laporan, dll) sama sekali tidak tersentuh.

---

## Yang sudah benar di MD asli, tidak perlu diubah
- BUG-01/02 (revoke + guard, minus catatan nama tabel di atas) — akurat, sesuai definisi live.
- BUG-03a (query purge >60 hari) — logic-nya benar, tapi **jalankan setelah** poin 2 & 3 di atas selesai dipasang, supaya path Storage sempat dikumpulkan dulu sebelum JSON-nya hilang.
- BUG-04–08 — cocok 1:1 dengan hasil Supabase security/performance advisor, tidak perlu tambahan.

## Urutan eksekusi revisi (gantikan urutan lama untuk BUG-03)
1. Buat bucket + RLS policy (poin 1)
2. Backfill 8 foto existing ke Storage (poin 2)
3. Ubah kode upload foto baru → langsung ke Storage (BUG-03c asli)
4. Ubah kode render chat → pakai signed URL (poin 4)
5. Pasang cron purge yang hapus Storage dulu baru JSON (poin 3, gantikan BUG-03b asli)
6. Baru jalankan BUG-03a (purge sisa histori lama yang sudah tidak ada fotonya)
