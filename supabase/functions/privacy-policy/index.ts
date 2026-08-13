Deno.serve(() => {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Privacy Policy - Catatan Keuangan</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6">
<h1>Privacy Policy - Catatan Keuangan</h1>
<p>Aplikasi ini adalah aplikasi pencatatan keuangan pribadi untuk penggunaan individu (single-user).</p>
<p>Data transaksi yang dicatat melalui WhatsApp maupun aplikasi web disimpan di database Supabase milik pengguna sendiri dan tidak dibagikan ke pihak ketiga mana pun.</p>
<p>Foto/gambar yang dikirim untuk analisis transaksi diproses sementara dan tidak disimpan secara permanen di server manapun.</p>
<p>Untuk pertanyaan, hubungi pemilik aplikasi.</p>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
});
