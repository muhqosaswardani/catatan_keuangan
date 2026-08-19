# Aturan Deployment & Git Push

## Aturan Wajib
Setiap kali menyelesaikan perubahan kode di workspace (baik pada frontend `index.html`, Edge Functions, maupun migrasi database), agent **WAJIB** melakukan langkah-langkah deployment berikut secara otomatis:

1. **Commit & Push ke Git:**
   - Tambahkan dan commit semua perubahan yang terjadi:
     ```powershell
     git add .
     git commit -m "deskripsi perubahan"
     ```
   - Lakukan push commit tersebut ke branch aktif di remote repository (biasanya `main`):
     ```powershell
     git push origin [nama-branch]
     ```

2. **Deploy Edge Functions (Jika Berubah):**
   - Jika terdapat perubahan kode pada folder `supabase/functions/<nama-function>/` (misal `wa-webhook`), wajib deploy ulang ke Supabase production:
     ```powershell
     supabase functions deploy <nama-function> --project-ref [project-ref] --no-verify-jwt --use-api
     ```

3. **Push Database Migrations (Jika Ada):**
   - Jika terdapat penambahan atau perubahan file di folder `supabase/migrations/`, wajib push migrasi tersebut ke database Supabase production:
     ```powershell
     supabase db push --project-ref [project-ref]
     ```

4. **Update Versi Aplikasi:**
   - Jika perubahan menyentuh `index.html`, pastikan untuk mengupdate versi di `index.html` sesuai ketentuan pada aturan versioning (`versioning.md`).
