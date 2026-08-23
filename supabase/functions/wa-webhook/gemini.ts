// supabase/functions/wa-webhook/gemini.ts
// Modul: Gemini API — REUSE prompt + schema PERSIS dari aiScanWithGemini() di index.html
// Baris referensi: index.html#L9008-9162

// ============================================================
// KONSTANTA (sama persis dengan index.html)
// ============================================================

const GEMINI_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.0-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];
const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Schema transaksi — constrained decoding (sama persis dengan transactionSchema di index.html#L9099)
export const TRANSACTION_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      order: { type: "INTEGER" },
      date: { type: "STRING" },
      type: { type: "STRING", enum: ["income", "expense"] },
      amount: { type: "NUMBER" },
      note: { type: "STRING" },
      category: { type: "STRING" },
      wallet: { type: "STRING" },
      isDuplicateRead: { type: "BOOLEAN" },
      groupId: { type: "STRING" },
      groupTotal: { type: "NUMBER" },
    },
    required: ["type", "amount", "note", "category"],
  },
};

// Schema edit instruksi (untuk reply-to-edit/delete)
export const EDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["edit", "delete", "unclear"] },
    amount: { type: "NUMBER" },
    category: { type: "STRING" },
    note: { type: "STRING" },
    wallet: { type: "STRING" },
    reason: { type: "STRING" }, // alasan kalau "unclear"
  },
  required: ["action"],
};

// ============================================================
// TIPE
// ============================================================

export interface GeminiPart {
  text?: string;
  inlineData?: {
    data: string; // base64
    mimeType: string;
  };
}

export interface ParsedTransaction {
  order?: number;
  date?: string;
  type: "income" | "expense";
  amount: number;
  note: string;
  category: string;
  wallet?: string;
  isDuplicateRead?: boolean;
  groupId?: string;
  groupTotal?: number;
}

export interface EditInstruction {
  action: "edit" | "delete" | "unclear";
  amount?: number;
  category?: string;
  note?: string;
  wallet?: string;
  reason?: string;
}
// ============================================================
// HELPER: Slang nominal Indonesia annotator
// ============================================================

const SLANG_NOMINAL_MAP: Record<string, number> = {
  seceng: 1000,
  goceng: 5000,
  ceban: 10000,
  noceng: 9000,
  goban: 50000,
  gocap: 50000,
};

export function annotateSlangNominalForAi(text: string): string {
  if (!text) return text;
  return text.replace(/\b(seceng|goceng|ceban|noceng|goban|gocap)\b/gi, (m) => {
    const val = SLANG_NOMINAL_MAP[m.toLowerCase()];
    return val ? `${m}(${val})` : m;
  });
}

// ============================================================
// HELPER: Prompt builder
// ============================================================

export function buildTransactionPrompt(
  expenseCats: string[],
  incomeCats: string[],
  todayStr: string,
): string {
  return (
    'Kamu asisten pencatatan keuangan pribadi yang ahli membaca berbagai sumber dokumen transaksi. Setiap lampiran bisa berupa salah satu dari ini:\n' +
    '(a) Foto/gambar struk belanja kasir/supermarket/toko (seperti Alfamart, Indomaret, dsb.) yang berisi daftar barang belanjaan (items) beserta diskon, PPN/pajak, dan grand total.\n' +
    '(b) Screenshot riwayat/mutasi m-banking atau e-wallet (list transaksi bertumpuk ke bawah).\n' +
    '(c) File dokumen PDF e-statement/rekening koran/riwayat mutasi.\n' +
    '(d) Foto BEBAS yang BUKAN struk/dokumen finansial — mis. foto barang/makanan yang baru dibeli, foto tempat/warung/toko/restoran, foto gerobak/kios/lapak pedagang, foto plang nama toko/banner/spanduk usaha, foto papan menu, foto antrian, atau foto lain yang relevan sebagai bukti/konteks transaksi meskipun tidak menampilkan nominal sama sekali.\n\n' +
    'Selain lampiran foto/dokumen di atas, kadang ada juga bagian terpisah bertanda awalan "TEKS_BEBAS_DARI_USER:" — itu adalah catatan transaksi yang diketik user sendiri dengan bahasa sehari-hari (boleh dipakai sendirian tanpa foto, atau digabung dengan foto sebagai keterangan/caption tambahan untuk foto yang dilampirkan). CATATAN: di bagian ini, beberapa kata slang nominal (seceng/goceng/ceban/noceng/goban/gocap) mungkin sudah diberi angka literal dalam kurung tepat setelahnya oleh sistem (mis. "parkir seceng(1000)") — itu HANYA petunjuk nilai nominal buat kamu, JANGAN disalin apa adanya (termasuk tanda kurungnya) ke field "note", tulis "note" secara natural seperti biasa (mis. "Parkir").\n\n' +
    '0. VALIDASI WAJIB SEBELUM MEMBUAT TRANSAKSI APAPUN (baca pelan-pelan, ini aturan PALING PENTING):\n' +
    '   - ATURAN JALAN PINTAS (paling utama, cek ini duluan sebelum aturan lain di bawah): kalau di dalam teks ADA ANGKA APAPUN yang bisa dibaca sebagai nominal uang — angka polos (mis. "2", "200", "300"), angka+satuan (mis. "300rb", "2rb", "2k", "4.3jt"), ATAU slang nominal (mis. "seceng", "goceng", "cepek", "ceban", "goban/gocap") — maka TERLEPAS SEAMBIGU APAPUN sisa kalimatnya, teks itu OTOMATIS DIANGGAP VALID dan WAJIB dibuatkan objek transaksinya. JANGAN PERNAH ditolak/dikeluarkan array kosong kalau ada angka semacam ini, apapun alasannya — cukup tentukan tebakan terbaik untuk "type"/"category"/"note", and "amount" diisi sesuai angka yang terdeteksi.\n' +
    '   - Kalau di dalam teks TIDAK ADA angka/nominal sama sekali DAN sisa kalimatnya juga ambigu (tidak jelas ada aktivitas ekonominya), barulah boleh dipertimbangkan untuk ditolak (array kosong) — TAPI tetap usahakan SEMINIMAL MUNGKIN menolak: kalau masih ada kata benda/kata kerja/nama tempat apapun yang berpotensi berkaitan aktivitas ekonomi meski tanpa angka (mis. "kopi", "parkir", "token listrik" tanpa nominal), tetap WAJIB diproses dengan amount 0 (lihat poin 4), BUKAN ditolak.\n' +
    '   - DEFINISI "transaksi": SEGALA kalimat/frasa yang menyiratkan ada aktivitas ekonomi — uang keluar, uang masuk, ATAU sekadar aktivitas yang LAZIMNYA melibatkan uang di kehidupan sehari-hari orang Indonesia — dianggap transaksi. Ini bukan cuma "beli barang": termasuk juga jasa/servis, transportasi/ongkos, parkir, makan/minum di suatu tempat, langganan (Netflix/Spotify/pulsa/paket data/token listrik/wifi/PDAM/gas), tagihan/cicilan (KPR/kartu kredit/asuransi/BPJS/pajak kendaraan), pendidikan (SPP/les/buku), kesehatan (obat/dokter/vitamin), sosial-keagamaan (zakat/infaq/sumbangan/kondangan/THR/amplop), denda/tilang, sewa, titip/minjem/minjemin/bayar utang, nabung/investasi/setor, gaji/bonus/THR/hasil jualan/uang saku, hadiah/kado, dan aktivitas ekonomi harian lain yang sejenis — daftar ini CONTOH bukan daftar tertutup, pakai penalaran umummu untuk kategori sejenis yang tidak disebut di sini.\n' +
    '   - Sikap default kamu adalah SANGAT PERMISIF/INKLUSIF: kalau ada keraguan sedikit pun, SELALU pilih untuk MENGANGGAP itu transaksi dan memprosesnya — jangan pernah menolak hanya karena tidak 100% yakin. Yang BOLEH ditolak (dikeluarkan array kosong []) HANYA kalau MEMENUHI SEMUA syarat ini sekaligus: (a) TIDAK ada angka/nominal sama sekali di kalimat (lihat ATURAN JALAN PINTAS di atas), DAN (b) kalimatnya cocok dengan salah satu dari 3 kategori sempit ini:\n' +
    '     (i) Sapaan/basa-basi murni tanpa konteks lain sama sekali (mis. "halo", "hai", "hallo", "test", "tes", "p", "min", "oy", "woi").\n' +
    '     (ii) Pertanyaan/perintah ke asisten yang TIDAK menyebut barang/jasa/tempat/aktivitas/nominal apapun (mis. "gimana cuaca hari ini", "kamu siapa", "gimana cara pakai aplikasi ini").\n' +
    '     (iii) Teks acak/gibberish yang benar-benar tidak bisa dimaknai sama sekali (mis. karakter/huruf ngawur tanpa makna).\n' +
    '     SELAIN kombinasi (a)+(b) di atas, WAJIB dianggap transaksi — termasuk kalimat pendek/singkat, satu kata benda saja (mis. "kopi", "bensin", "token listrik"), frasa TANPA kata kerja sama sekali, frasa TANPA nominal sama sekali (asal bukan kategori (i)/(ii)/(iii)), dan frasa yang aktivitasnya belum tentu 100% jelas jenisnya.\n' +
    '   - JANGAN tertipu oleh typo, singkatan, bahasa gaul, ejaan tidak baku, ATAU kalimat yang ditulis terlalu ringkas/santai — koreksi dulu di kepalamu sebelum memutuskan apakah itu transaksi. Contoh: "beneirn hp rusak lcd rusak 300 rb" adalah typo dari "benerin hp rusak lcd rusak 300rb" = jasa servis/reparasi HP (LCD rusak) senilai Rp300.000 — ini transaksi expense yang VALID dan JELAS, bukan gibberish, dan HARUS diproses (bukan ditolak) meskipun ada typo/ejaan berantakan.\n' +
    '   - Kata kerja jasa/servis umum (typo maupun baku) seperti "benerin/perbaiki/servis/reparasi/betulin/ganti [barang]" SELALU dianggap transaksi jasa yang valid, dengan kategori paling mendekati "Jasa"/"Servis"/kategori sejenis dari daftar kategori yang tersedia, atau "Lainnya" kalau tidak ada yang cocok.\n' +
    '   - Kalau ada indikasi transaksi sekecil apapun — nama barang/jasa/tempat/aktivitas finansial, ATAU ada nominal uang (angka + "rb"/"ribu"/"rp"/"k"/"jt"/"juta" dsb) di dalam kalimat — WAJIB diproses jadi transaksi, walaupun konteksnya tidak lengkap 100% jelas, walaupun cuma satu-dua kata, walaupun tanpa kata kerja, dan walaupun tanpa nominal sama sekali. Cukup lakukan tebakan terbaik untuk "type", "category", dan "note" (amount boleh 0 kalau memang tidak ada nominalnya sama sekali — lihat poin 4); JANGAN dibuang.\n' +
    '   - CEK ULANG SEBELUM MENGELUARKAN ARRAY KOSONG: sebelum kamu memutuskan untuk tidak membuat objek transaksi sama sekali (array kosong []), WAJIB baca ulang teksnya sekali lagi dan pastikan: (1) benar-benar TIDAK ADA angka/nominal apapun di teks (lihat ATURAN JALAN PINTAS), DAN (2) betul-betul cocok dengan salah satu dari 3 kategori sempit (i)/(ii)/(iii) di atas. Kalau ada angka SAMA SEKALI, atau ada SATU SAJA kata benda/kata kerja/nama tempat yang berpotensi berkaitan aktivitas ekonomi, itu BUKAN array kosong — buat objek transaksinya.\n' +
    '   - Untuk kasus yang benar-benar tidak ada kaitan finansial (3 kategori sempit di atas), JANGAN dipaksakan jadi transaksi dengan kategori "Lainnya" — cukup ABAIKAN, jangan hasilkan objek apapun untuk bagian itu (kalau seluruh input begini, keluarkan array kosong []).\n\n' +
    'CARA MEMBACA DOKUMEN:\n' +
    '1. JIKA DOKUMEN ADALAH STRUK BELANJA TOKO/SUPERMARKET (Itemized Receipt):\n' +
    '   - AI harus memecah pengeluaran berdasarkan kategori barang yang dibeli secara dinamis sesuai daftar kategori kustom yang dikirim secara real-time ini. Gunakan daftar kategori expense berikut: [' + expenseCats.join(', ') + '].\n' +
    '   - Aturan klasifikasi kategori penting (Ikuti panduan ini agar klasifikasi akurat):\n' +
    '     * "Makan" (atau kategori makanan utama): Khusus untuk makanan berat/pokok. Contoh: nasi, nugget, mie (mie ayam/mie goreng/indomie sebagai makanan berat), bakso, ayam geprek, lauk-pauk siap saji, dsb.\n' +
    '     * "Jajan" (atau kategori snack/camilan): Khusus untuk makanan/minuman ringan, camilan, minuman manis/kemasan. Contoh: es krim, kopi (instan/kemasan/kopi kekinian), ciki/snack, permen, cokelat, minuman manis/soda (Frestea, Sprite, dll), roti manis, dsb.\n' +
    '     * "Sembako": Khusus untuk bahan mentah dapur dasar (minyak goreng, beras karung, gula pasir, garam, dsb).\n' +
    '     * "Belanja": Khusus untuk kebutuhan rumah tangga non-konsumsi (seperti sabun mandi, detergen, pasta gigi, tisu, shampoo, sikat gigi, dsb).\n' +
    '     * Jika ada kategori kustom baru yang baru saja ditambahkan oleh pengguna, pilihlah jika nama kategorinya lebih spesifik dan cocok dengan barang yang dibeli.\n' +
    '   - Kelompokkan barang-barang belanjaan tersebut ke dalam kategori-kategori yang sesuai. Untuk SETIAP kategori yang ditemukan, buat SATU objek pengeluaran ("type": "expense").\n' +
    '   - Hitung nilai "amount" bersih untuk kategori tersebut. Caranya: hitung subtotal harga barang dalam kategori tersebut, lalu kurangi diskon barang tersebut, dan TAMBAHKAN PPN/Pajak secara proporsional. Pastikan jika jumlah "amount" dari semua kategori pengeluaran ini dijumlahkan, hasilnya cocok 100% dengan Grand Total (Total Bayar) yang tertera di struk belanja.\n' +
    '   - Berikan "note" berupa deskripsi ringkas berisi nama toko diikuti rincian barang dalam kategori tersebut (misal: "Alfamart - Makan (Abon)" atau "Alfamart - Jajan (Mentos)").\n' +
    '   - Tetapkan tanggal "date" (YYYY-MM-DD) sesuai tanggal transaksi di struk belanja.\n\n' +
    '2. JIKA DOKUMEN ADALAH MUTASI REKENING/M-BANKING/E-WALLET/PDF STATEMENT:\n' +
    '   - Baca dokumen baris per baris dari atas ke bawah.\n' +
    '   - Setiap baris transaksi terpisah (punya keterangan/waktu sendiri) dicatat sebagai transaksi TERSENDIRI, walaupun nominal/tanggalnya sama persis.\n' +
    '   - Untuk setiap transaksi mutasi, buat satu objek dengan field: "order" (integer), "date" (YYYY-MM-DD, asumsikan tahun ' + new Date().getFullYear() + ' jika tidak tertulis), "type" ("expense" atau "income"), "amount" (integer rupiah), "note" (keterangan transaksi), "category" (pilih yang paling cocok dari daftar: expense: [' + expenseCats.join(', ') + '], income: [' + incomeCats.join(', ') + ']; atau "Lainnya"), "wallet" (isi jika nama dompet/rekening disebutkan di mutasi, jika tidak kosongkan), "isDuplicateRead" (boolean).\n\n' +
    '3. JIKA FOTO BUKAN STRUK/DOKUMEN FINANSIAL (foto bebas — barang, tempat, gerobak, banner, papan menu, antrian, dsb):\n' +
    '   - Kenali & interpretasikan isi foto seluas-luasnya: apa yang terlihat, termasuk tulisan pada banner/plang/papan menu kalau ada.\n' +
    '   - Susun "note" yang jelas dari isi foto (contoh: foto gerobak bertuliskan "Bakso Pak Kumis" → note "Bakso Pak Kumis"; foto plang "Bengkel Motor Jaya" → note "Servis di Bengkel Motor Jaya"). Jika kamu tidak tahu nama barang/jasa yang konkret dengan yakin, isi field "note" dengan string kosong "".\n' +
    '   - Tebak "category" paling masuk akal dari daftar kategori yang ada (expense: [' + expenseCats.join(', ') + '], income: [' + incomeCats.join(', ') + ']; atau "Lainnya" kalau tidak ada yang cocok).\n' +
    '   - "amount": HANYA isi kalau ada angka rupiah yang benar-benar tertulis JELAS terlihat di foto itu sendiri (mis. label harga di papan menu) ATAU disebutkan di TEKS_BEBAS_DARI_USER yang menyertai foto ini (diperlakukan sebagai caption). Kalau tidak ada satu pun sumber nominal yang jelas, set "amount" ke 0 — JANGAN MENEBAK nominal untuk jenis foto ini.\n' +
    '   - "date": default hari ini (' + todayStr + ') kalau tidak ada info tanggal di foto/caption.\n\n' +
    '4. JIKA ADA BAGIAN TEKS_BEBAS_DARI_USER (dan bukan sekadar caption untuk kasus 3 di atas, atau memang berdiri sendiri tanpa foto):\n' +
    '   - Pecah jadi beberapa objek transaksi TERPISAH kalau isinya berisi lebih dari satu transaksi berbeda. Pemisah BISA berupa koma, kata "dan", atau baris baru — TAPI JUGA bisa TANPA pemisah eksplisit sama sekali (mis. transkrip suara/VN yang ngalir panjang tanpa koma/titik yang jelas). Untuk kasus tanpa pemisah eksplisit ini, kenali batas antar transaksi dari PERGANTIAN KONTEKS: setiap kali muncul nama barang/jasa/aktivitas BARU yang beda dari sebelumnya, atau muncul angka nominal baru yang jelas menempel ke aktivitas tertentu, itu pertanda transaksi baru dimulai — meskipun tidak ada tanda baca pemisah sama sekali. Baca seluruh teks dulu secara utuh sebelum memutuskan pembagiannya, jangan asal potong per kalimat pendek.\n' +
    '   - Jika user menyebutkan nama dompet secara eksplisit di pesan (mis. \'dari dompet tabungan\', \'rekening kas\', \'pake tabungan\'), isi field "wallet" dengan nama dompet yang disebut tersebut. Jika tidak disebutkan, kosongkan (isi "" atau null).\n' +
    '   - JANGAN PERNAH mengisi field "note" dengan kata generik seperti "Pengeluaran", "Pemasukan", "Transaksi", or "Lainnya". Jika dari input (teks/foto/VN) kamu tidak tahu nama barang/jasa yang konkret dengan yakin, isi field "note" dengan string kosong "" agar sistem bisa bertanya langsung ke user.\n' +
    '   - Kenali nama barang/jasa/aktivitas APAPUN meski ditulis singkatan/istilah gaul/bahasa sehari-hari Indonesia (formal maupun informal, termasuk variasi daerah & gaul kekinian — bukan cuma daftar tertutup, pakai pengetahuan umummu di SEMUA kategori kehidupan sehari-hari, bukan cuma makanan). Contoh lintas kategori: makanan/minuman ("naskun"→Nasi kuning, "nasgor"→Nasi goreng, "baso"→Bakso, "indomie"→Mie instan, "esteh"→Es teh, "kopsus"→Kopi susu, "gepuk/geprek"→Ayam geprek); transportasi/bensin ("bensin"/"bensol"→BBM, "ojol"→ojek online, "parkir"); pulsa/langganan ("token"→token listrik, "paketan"/"kuota"→paket data, "streaming"→Netflix/Spotify dsb); jasa/servis ("benerin/betulin/service"); tagihan ("PDAM"→air, "bpjs", "cicilan"/"kredit"); sosial-keagamaan ("kondangan", "amplopan", "infaq/zakat", "arisan"); kesehatan ("obat", "vitamin", "dokter"); lalu tulis "note" dalam bentuk jelas dibaca (boleh diperjelas dari singkatannya). Jika benar-benar tidak tahu barang/jasanya dengan yakin, isi "note" dengan string kosong "".\n' +
    '   - Pahami berbagai format penulisan nominal informal ala Indonesia: "25rb"/"25 ribu"=25000; "4.3jt"/"4,3 juta"=4300000; ANGKA POLOS BERKOMA TANPA SATUAN JT/RB DI BELAKANGNYA (mis. "2,5", "32,75", "1,5") — koma di sini SELALU dibaca sebagai desimal dari satuan RIBU, TIDAK PEDULI konteks/jenis barangnya apa (walau kelihatannya "kemahalan"/"kemurahan" untuk barang itu, mis. wifi/kontrakan/cicilan sekalipun) — RUMUS TETAP: "2,5"=2500, "1,5"=1500, "32,75"=32750, JANGAN PERNAH ditafsirkan sebagai juta (mis. "2,5"≠2500000) kecuali user eksplisit menulis satuan "jt"/"juta" setelahnya (mis. "2,5jt"/"2,5 juta"=2500000 — beda kasus, ada satuannya). Konsisten pakai rumus ini di SEMUA konteks kalimat, jangan menebak-nebak beda tiap kali dipanggil. Contoh: "wifi 2,5" → amount 2500 (BUKAN 2500000, BUKAN 250, BUKAN 25000 — persis 2500 sesuai rumus koma-desimal-ribu). "32,75"=32750; "1k"/"2k"/"5k"=1000/2000/5000; angka dieja ("seribu"=1000, "dua ribu"=2000, "sepuluh ribu"=10000, "seratus ribu"=100000); SLANG NOMINAL KHAS INDONESIA (WAJIB dikenali): "seceng"=1000, "goceng"=5000, "ceban"=10000, "noceng"=9000, "cepek"=100 (tapi kalau konteksnya jelas transaksi harian yang wajar, "cepek" sering juga berarti 100.000 — pilih yang paling masuk akal dari konteks), "goban"/"gocap"=50000, "toserba"/"nogo"=9000; angka polos tanpa satuan yang relatif kecil (kira-kira di bawah 1000, mis. "25","10","100") dalam konteks kalimat nominal transaksi harian = DIKALIKAN 1000 (mis. "25"→25000), KECUALI angka itu sudah ditulis lengkap berdigit banyak (mis. "25000","150000") maka dipakai apa adanya TANPA dikalikan lagi. Kalau ragu-ragu soal nominal spesifik, tetap keluarkan hasil terbaik pakai estimasi/tebakan wajar — JANGAN sampai gara-gara nominal ambigu, seluruh transaksinya malah tidak dikeluarkan sama sekali (transaksi TETAP harus dibuat, kalau benar-benar tidak bisa ditebak baru amount diisi 0).\n' +
    '   - "type": "income" kalau jelas pemasukan (mis. "gaji masuk", "dapat bonus"), selain itu "expense".\n' +
    '   - "amount": JANGAN PERNAH MENEBAK/MENGARANG NOMINAL/HARGA BARANG/JASA. Mengarang/mengestimasi harga hanya boleh dilakukan jika ada beberapa item dengan kategori berbeda dalam satu batch DAN memiliki TOTAL BELANJA (groupTotal/grand total) yang jelas disebutkan, sehingga total tersebut bisa dibagi-bagi secara proporsional. Jika tidak ada total belanja yang disebutkan, dan tidak ada harga per item yang disebutkan, kamu WAJIB mengisi field "amount" dengan 0. Jangan pernah menebak harga pasar barang/jasa tersebut (misal jika ada item "tisue" tanpa harga, "amount" harus 0, jangan dikarang harganya!).\n' +
    '   - "date": default hari ini (' + todayStr + ') kalau tidak disebutkan tanggal lain di teks.\n\n' +
    '5. ALOKASI KATEGORI & ESTIMASI HARGA DARI SATU TOTAL TANPA RINCIAN PER ITEM (berlaku untuk foto belanjaan ATAU teks bebas yang menyebut beberapa barang beda kategori tapi HANYA memberi satu total nominal, TANPA rincian harga per barang — beda dengan kasus 1 di atas yang rinciannya memang tertulis di struk):\n' +
    '   - Kenali semua barang berbeda yang disebut/terlihat, masing-masing dengan "category" paling sesuai (JANGAN taruh semua barang di satu kategori sama demi kemudahan — ini sama pentingnya dengan total yang presisi).\n' +
    '   - PENTING — ATURAN PENGGABUNGAN PER KATEGORI (WAJIB diikuti persis): satu objek transaksi mewakili SATU KATEGORI dalam kelompok itu, BUKAN satu objek per barang. Kalau ada 2+ barang berbeda yang jatuh ke kategori YANG SAMA (mis. beras dan minyak sama-sama "Makan"), GABUNG jadi SATU objek transaksi untuk kategori itu — "amount" diisi jumlah estimasi gabungan barang-barang tsb, dan "note" digabung sebutin semua barangnya (mis. "Alfamart - Beras, Minyak"). Barang dengan kategori berbeda tetap jadi objek terpisah masing-masing.\n' +
    '     - PENGECUALIAN KHUSUS kategori "Lainnya": barang-barang yang masuk kategori "Lainnya" TETAP dipisah SATU objek per barang (JANGAN digabung sesama "Lainnya"), karena catatan "Lainnya" butuh rincian jelas tiap barangnya berhubung jenisnya gak seragam. Aturan gabung-per-kategori di atas HANYA berlaku untuk kategori selain "Lainnya".\n' +
    '     - Contoh: belanja alfamart total 350rb isinya beras (Makan), minyak (Makan), sabun (Belanja) → HASIL AKHIR 2 objek saja: (1) category "Makan", note "Alfamart - Beras, Minyak", amount = estimasi beras+minyak digabung; (2) category "Belanja", note "Alfamart - Sabun", amount = estimasi sabun. BUKAN 3 objek terpisah.\n' +
    '   - "amount" tiap objek (yang mewakili satu kategori, sudah digabung kalau ada beberapa barang sekategori) diisi ESTIMASI KASAR total harga barang-barang di kategori itu berdasarkan pengetahuan umum harga pasar Indonesia (nilai ini hanya dipakai sisi aplikasi sebagai BOBOT proporsional antar objek, boleh kasar/tidak presisi).\n' +
    '   - Beri SEMUA objek dari satu kelompok alokasi ini "groupId" yang SAMA (string bebas, unik per kelompok dalam satu respons ini, mis. "g1", "g2" kalau ada lebih dari satu kelompok begini dalam satu respons), dan "groupTotal" (integer) berisi TOTAL NOMINAL PERSIS seperti yang disebutkan/diinput user untuk kelompok itu. Kedua field ini WAJIB diisi kalau baris berasal dari kasus alokasi tanpa rincian ini (di luar kasus ini, boleh dikosongkan/tidak disertakan).\n' +
    '   - JANGAN mencoba menjumlahkan sendiri "amount" tiap objek supaya pas dengan total — sisi aplikasi yang akan menyesuaikan angka final secara presisi memakai "groupTotal" yang kamu berikan. Fokusmu cukup: kategori tiap objek benar (sudah digabung sesuai aturan di atas) & proporsi estimasi harga antar objek masuk akal.\n\n' +
    'CONTOH TEKS_BEBAS_DARI_USER YANG WAJIB DIANGGAP TRANSAKSI VALID (JANGAN PERNAH ditolak/dikeluarkan array kosong untuk kalimat semacam ini — typo, gaul, atau nominal ditulis santai BUKAN alasan untuk menolak):\n' +
    '   - "benerin ac gaada dingin 300rb" → expense, note "Servis AC (tidak dingin)", amount 300000, category paling dekat "Jasa"/"Servis"/"Rumah Tangga" atau "Lainnya".\n' +
    '   - "ganti layar hp pecah 450rb" → expense, note "Ganti layar HP (pecah)", amount 450000, category "Jasa"/"Servis"/"Elektronik" atau "Lainnya".\n' +
    '   - "parkir seceng" → expense, note "Parkir", amount 1000 (seceng=1000), category "Transportasi" atau sejenisnya.\n' +
    '   - "beneirn hp rusak lcd rusak 300 rb" → expense, note "Servis HP (LCD rusak)", amount 300000.\n' +
    '   - "cabut ojol ke kantor 12rb" → expense, note "Ojol ke kantor", amount 12000, category "Transportasi".\n' +
    '   - "kena tilang 100rb duh" → expense, note "Tilang", amount 100000.\n' +
    '   - "potong rambut abis 25rb" → expense, note "Potong rambut", amount 25000, category "Jasa"/"Perawatan" atau "Lainnya".\n' +
    '   - "tambal ban bocor 10rb" → expense, note "Tambal ban", amount 10000.\n' +
    '   - "token listrik 50rb" → expense, note "Token listrik", amount 50000, category "Tagihan"/"Rumah Tangga" atau "Lainnya".\n' +
    '   - "kopi" (cuma satu kata, tanpa kata kerja, tanpa nominal sama sekali) → expense, note "Kopi", amount 0, category "Jajan"/"Makan" atau "Lainnya" — TETAP dibuatkan objeknya, JANGAN dianggap terlalu singkat untuk diproses.\n' +
    '   - "dapat THR 500rb dari kantor" → income, note "THR dari kantor", amount 500000, category "Gaji"/"Pemasukan Lain" atau "Lainnya".\n' +
    '   - "wifi 2,5" → expense, note "Bayar wifi", amount 2500 (rumus koma-desimal-ribu berlaku KONSISTEN di semua konteks, termasuk tagihan besar seperti wifi — JANGAN ditafsir jadi 2500000 hanya karena "kelihatannya" wifi biasanya mahal; ikuti angka literalnya apa adanya).\n' +
    '   - "minjemin duit ke Budi 200rb" → expense, note "Pinjamkan uang ke Budi", amount 200000, category "Lainnya".\n' +
    '   - "jadi tadi pagi aku ke pasar beli sayur 25rb terus mampir warkop ngopi 8rb abis itu ke bengkel benerin ban bocor 15rb" (contoh gaya transkrip VN panjang tanpa koma/pemisah jelas) → HARUS dipecah jadi 3 transaksi terpisah berdasarkan pergantian konteks aktivitas: (1) expense "Beli sayur di pasar" 25000, (2) expense "Ngopi di warkop" 8000, (3) expense "Tambal ban bocor" 15000 — JANGAN digabung jadi satu transaksi besar atau dianggap gagal parse hanya karena tidak ada tanda baca pemisah.\n' +
    'Pola umumnya: SELAMA ada kata benda/kata kerja/nama tempat/aktivitas apapun yang berpotensi berkaitan aktivitas ekonomi (benerin/ganti/servis/parkir/potong/tambal/beli/bayar/jual/dapat/dsb, ATAU sekadar nama barang/jasa/tempat tanpa kata kerja sama sekali) — walau ditulis santai, typo, terlalu singkat, nominalnya pakai istilah gaul, ATAU tanpa nominal sama sekali — WAJIB tetap dibuatkan objek transaksinya. JANGAN biarkan ketidakpastian soal kategori, kejelasan nominal, ATAU singkatnya kalimat membuatmu menolak keseluruhan transaksinya; pilih tebakan terbaik dan tetap keluarkan objeknya. Array kosong [] HANYA untuk 3 kategori sempit di aturan 0.\n\n' +
    'Keluaran (Output) yang harus kamu berikan HANYA berupa array JSON berisi objek-objek transaksi tersebut (field standar: order, date, type, amount, note, category, wallet, isDuplicateRead — tambahkan "groupId" dan "groupTotal" HANYA untuk kasus alokasi di poin 5), tanpa penjelasan markdown, tanpa code fence.'
  );
}

// ============================================================
// CORE: callGeminiRaw — rotasi key + model fallback
// ============================================================

export async function callGeminiRaw(
  apiKeys: string[],
  parts: GeminiPart[],
  temperature = 0.7,
  responseSchema?: Record<string, unknown>,
): Promise<unknown> {
  const RETRYABLE_STATUS = [403, 404, 429, 503];
  let lastErr: Error | null = null;
  const numKeys = apiKeys.length;
  const numModels = GEMINI_MODELS.length;

  if (numKeys === 0) {
    throw new Error("Tidak ada Gemini API Key yang dikonfigurasi.");
  }

  const startKeyIdx = Math.floor(Math.random() * numKeys);
  const startModelIdx = Math.floor(Math.random() * numModels);

  for (let k = 0; k < numKeys; k++) {
    const kIdx = (startKeyIdx + k) % numKeys;
    const apiKey = apiKeys[kIdx];

    for (let m = 0; m < numModels; m++) {
      const mIdx = (startModelIdx + m) % numModels;
      const model = GEMINI_MODELS[mIdx];
      const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const generationConfig: Record<string, unknown> = {
        temperature,
        maxOutputTokens: 2048,
      };

      // Matikan thinking untuk model yang mendukungnya (bukan 2.0)
      if (!/2\.0/.test(model)) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      if (responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = responseSchema;
      }

      let res: Response;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig,
          }),
          signal: controller.signal,
        });
      } catch (networkErr) {
        lastErr = new Error(
          `Gagal menghubungi Gemini API: ${(networkErr as Error)?.message ?? "koneksi terputus atau timeout"}`,
        );
        continue;
      } finally {
        clearTimeout(timeoutId);
      }

      if (res.ok) {
        return await res.json();
      }

      const errText = await res.text().catch(() => "");
      let friendly = "";
      if (res.status === 400) friendly = "Request tidak valid.";
      else if (res.status === 403) friendly = "API Key ditolak / kuota habis.";
      else if (res.status === 404)
        friendly = `Model "${model}" tidak ditemukan.`;
      else if (res.status === 429) friendly = "Rate limit / kuota habis.";
      else if (res.status === 503) friendly = "Server Gemini overload.";

      lastErr = new Error(
        `Gemini API (Key #${kIdx + 1}, ${model}) error ${res.status}${friendly ? ` - ${friendly}` : ""}${errText ? ` (${errText.slice(0, 150)})` : ""}`,
      );

      if (RETRYABLE_STATUS.includes(res.status)) continue;
      else continue;
    }
  }

  throw lastErr ?? new Error("Semua API Key dan Model Gemini gagal dipanggil.");
}

// ============================================================
// Ekstrak teks dari response Gemini
// ============================================================

export function extractGeminiText(data: unknown): string {
  const d = data as Record<string, unknown>;
  const cands = d?.candidates as Record<string, unknown>[] | undefined;
  const cand = cands?.[0];
  const content = cand?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Record<string, unknown>[] | undefined;

  if (!Array.isArray(parts) || !parts.length)
    throw new Error("Respons AI kosong");

  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text as string)
    .join("");

  if (!text.trim()) throw new Error("Respons AI kosong");
  return text;
}

// ============================================================
// Parse JSON dari text (bersihkan code fence kalau ada)
// ============================================================

export function parseAiJson(text: string): ParsedTransaction[] {
  let clean = text.trim();
  // Hapus code fence markdown kalau ada
  clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed))
    throw new Error("Format respons AI tidak valid (bukan array)");
  return parsed as ParsedTransaction[];
}

// ============================================================
// Panggil Gemini untuk parse transaksi (MAX 3 percobaan)
// ============================================================

export async function parseTransactions(
  apiKeys: string[],
  parts: GeminiPart[],
  expenseCats: string[],
  incomeCats: string[],
  todayStr: string,
): Promise<ParsedTransaction[]> {
  const promptText = buildTransactionPrompt(expenseCats, incomeCats, todayStr);
  const allParts: GeminiPart[] = [{ text: promptText }, ...parts];

  const MAX_ATTEMPTS = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await callGeminiRaw(
        apiKeys,
        allParts,
        0.15,
        TRANSACTION_SCHEMA,
      );
      const text = extractGeminiText(data);
      const parsed = parseAiJson(text);
      return parsed;
    } catch (e) {
      lastErr = e as Error;
      console.warn(
        `parseTransactions: percobaan ${attempt}/${MAX_ATTEMPTS} gagal — ${lastErr?.message}`,
      );
      if (attempt < MAX_ATTEMPTS) continue;
    }
  }

  throw lastErr ?? new Error("Format respons AI tidak valid");
}

// ============================================================
// Transkripsi audio (voice note) ke teks polos.
// Dipakai SEBELUM parseTransactions supaya voice note melewati alur
// klasifikasi intent yang sama seperti pesan teks (cek saldo, query "?",
// checklist, transfer, dll) — bukan langsung dianggap transaksi.
// ============================================================

export async function transcribeAudioToText(
  apiKeys: string[],
  base64Audio: string,
  mimeType: string,
): Promise<string> {
  const promptText =
    `Dengarkan rekaman suara (voice note) berikut dan transkripsikan PERSIS apa yang diucapkan ` +
    `ke dalam teks Bahasa Indonesia apa adanya (tanpa menambah/mengurangi makna, tanpa tanda kutip, ` +
    `tanpa penjelasan tambahan). Keluarkan HANYA teks transkripnya saja.`;

  const parts: GeminiPart[] = [
    { text: promptText },
    { inlineData: { data: base64Audio, mimeType } },
  ];

  const data = await callGeminiRaw(apiKeys, parts, 0.1);
  const text = extractGeminiText(data);
  return text.trim().replace(/^["']|["']$/g, "");
}

// ============================================================
// Panggil Gemini untuk parse edit instruction (reply-to-edit/delete)
// ============================================================

export async function parseEditInstruction(
  apiKeys: string[],
  userReply: string | GeminiPart[],
  currentTransaction: Record<string, unknown>,
  expenseCats: string[],
  incomeCats: string[],
  walletNames: string[],
): Promise<EditInstruction> {
  const promptText =
    `Kamu asisten keuangan. User membalas (reply) ke pesan konfirmasi transaksi berikut:\n` +
    `${JSON.stringify(currentTransaction, null, 2)}\n\n` +
    (typeof userReply === "string" ? `Teks balasan user: "${userReply}"\n\n` : `User mengirim rekaman suara (audio) berisi instruksi balasan.\n\n`) +
    `Tentukan apa instruksi user:\n` +
    `- "edit": update satu atau beberapa field (amount, category, note, wallet)\n` +
    `- "delete": hapus transaksi ini\n` +
    `- "unclear": instruksi tidak jelas, minta klarifikasi\n\n` +
    `Kategori expense yang tersedia: [${expenseCats.join(", ")}]\n` +
    `Kategori income yang tersedia: [${incomeCats.join(", ")}]\n\n` +
    `Dompet yang tersedia: [${walletNames.join(", ")}]\n\n` +
    `Keluarkan JSON sesuai schema. Untuk "edit", isi hanya field yang berubah (kosongkan field yang tidak disebutkan user).` +
    ` Untuk "unclear", isi "reason" dengan penjelasan singkat apa yang perlu diklarifikasi.`;

  const parts: GeminiPart[] = [{ text: promptText }];
  if (typeof userReply === "string") {
    // String is already included in promptText
  } else {
    parts.push(...userReply);
  }

  const data = await callGeminiRaw(
    apiKeys,
    parts,
    0.1,
    EDIT_SCHEMA,
  );
  const text = extractGeminiText(data);

  let clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  return JSON.parse(clean) as EditInstruction;
}

// ============================================================
// Panggil Gemini untuk respons natural (pesan ambigu)
// ============================================================

export async function generateNaturalResponse(
  apiKeys: string[],
  userMessage: string,
): Promise<string> {
  const prompt =
    `Kamu asisten pencatatan keuangan pribadi lewat WhatsApp, bahasa santai Indonesia.\n` +
    `User mengirim pesan: "${userMessage}"\n\n` +
    `Pesan ini BUKAN transaksi keuangan (tidak ada info barang/jasa/nominal).\n` +
    `Balas dengan natural, singkat, dan helpful — maksimal 2 kalimat.\n` +
    `JANGAN membuat transaksi. Cukup balas dengan teks biasa.`;

  const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.8);
  const text = extractGeminiText(data);
  return text.trim();
}

// ============================================================
// Panggil Gemini untuk menyusun pertanyaan klarifikasi natural
// ============================================================

export async function generateClarificationQuestion(
  apiKeys: string[],
  context: { type: "note" | "amount"; note?: string; amount?: number },
): Promise<string> {
  let prompt = "";
  if (context.type === "amount") {
    prompt = `Kamu adalah asisten keuangan pribadi yang ramah, sopan, dan santai. Buatkan kalimat pertanyaan chat WhatsApp yang natural, singkat, dan santai dalam bahasa Indonesia sehari-hari untuk menanyakan berapa nominal/harga dari transaksi berikut.\n\n` +
      `Keterangan transaksi: "${context.note}"\n\n` +
      `Aturan:\n` +
      `- Jangan kaku, buat pertanyaan natural layaknya teman chat (misalnya: "Btw, [nama barang] ini harganya berapa ya?" atau variasi santai lainnya).\n` +
      `- Jangan bertele-tele, maks 1-2 kalimat pendek.\n` +
      `- Jangan ada emoji sama sekali.\n` +
      `- Keluarkan HANYA teks pertanyaan tersebut saja.`;
  } else {
    const amtLabel = formatRupiah(context.amount ?? 0);
    prompt = `Kamu adalah asisten keuangan pribadi yang ramah, sopan, dan santai. Buatkan kalimat pertanyaan chat WhatsApp yang natural, singkat, dan santai dalam bahasa Indonesia sehari-hari untuk menanyakan apa keterangan/kegunaan dari pengeluaran uang sebesar ${amtLabel} berikut.\n\n` +
      `Nominal transaksi: ${amtLabel}\n\n` +
      `Aturan:\n` +
      `- Jangan kaku, buat pertanyaan natural layaknya teman chat (misalnya: "Uang Rp[nominal] tadi buat bayar apa ya?" atau variasi santai lainnya).\n` +
      `- Jangan bertele-tele, maks 1-2 kalimat pendek.\n` +
      `- Jangan ada emoji sama sekali.\n` +
      `- Keluarkan HANYA teks pertanyaan tersebut saja.`;
  }

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.7);
    const text = extractGeminiText(data).trim();
    return text.replace(/^["']|["']$/g, "") || (context.type === "amount" ? `${context.note} ini harganya berapa?` : `${formatRupiah(context.amount ?? 0)} ini buat bayar apa?`);
  } catch {
    return context.type === "amount"
      ? `${context.note} ini harganya berapa?`
      : `${formatRupiah(context.amount ?? 0)} ini buat bayar apa?`;
  }
}

// ============================================================
// Panggil Gemini untuk merinci jawaban klarifikasi user secara holistik
// ============================================================

export async function parseClarificationReply(
  apiKeys: string[],
  userReply: string,
  pendingTx: { type: string; amount: number; note: string; category: string },
  expenseCats: string[],
  incomeCats: string[],
): Promise<{ amount: number; note: string; category: string }> {
  const cats = pendingTx.type === "expense" ? expenseCats : incomeCats;
  
  const prompt =
    `Kamu asisten keuangan pribadi yang cerdas. User sedang mengklarifikasi transaksi yang tertunda karena informasi yang kurang lengkap.\n\n` +
    `Data Transaksi Saat Ini:\n` +
    `- Tipe: ${pendingTx.type}\n` +
    `- Nominal: ${pendingTx.amount}\n` +
    `- Catatan: "${pendingTx.note}"\n` +
    `- Kategori Saat Ini: "${pendingTx.category}"\n\n` +
    `Jawaban/Balasan User: "${userReply}"\n\n` +
    `Daftar Kategori yang Tersedia: [${cats.join(", ")}]\n\n` +
    `Tugasmu adalah menganalisis balasan user dan memperbarui field transaksi (nominal, catatan, kategori) secara cerdas:\n` +
    `1. Nominal ("amount"): Perbarui jika user menyebutkan angka nominal baru untuk mengoreksi nominal saat ini. Jika tidak ada nominal baru yang disebutkan, tetap gunakan nominal saat ini.\n` +
    `2. Catatan ("note"): Bersihkan dan perbarui keterangan transaksi jika user menyebutkan keterangan baru (contoh: "es campur" -> "Es Campur", "buat bayar parkir" -> "Parkir"). Jangan biarkan catatan berisi basa-basi/kata tidak penting.\n` +
    `3. Kategori ("category"): Klasifikasikan catatan ("note") yang baru/terupdate ke salah satu kategori dari Daftar Kategori yang Tersedia. Ikuti aturan klasifikasi:\n` +
    `   - "Makan": Khusus untuk makanan berat/pokok. Contoh: nasi, nugget, mie, bakso, geprek, dsb.\n` +
    `   - "Jajan": Khusus untuk makanan/minuman ringan, camilan, soda, kopi, roti manis, dsb.\n` +
    `   - "Sembako": Khusus untuk bahan mentah dapur dasar (minyak, beras, gula, dsb).\n` +
    `   - "Belanja": Khusus untuk kebutuhan rumah tangga non-konsumsi (sabun, detergen, pasta gigi, tisu, dsb).\n` +
    `   - Jika tidak ada yang cocok dari daftar kategori, pilih "Lainnya" (atau kategori kustom yang ada di daftar jika lebih spesifik).\n\n` +
    `Keluarkan hasil analisis dalam format JSON dengan properti exact berikut:\n` +
    `{\n` +
    `  "amount": number,\n` +
    `  "note": "string",\n` +
    `  "category": "string"\n` +
    `}\n\n` +
    `Jangan berikan penjelasan lain di luar JSON.`;

  const schema = {
    type: "OBJECT",
    properties: {
      amount: { type: "NUMBER" },
      note: { type: "STRING" },
      category: { type: "STRING" },
    },
    required: ["amount", "note", "category"],
  };

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.1, schema);
    const text = extractGeminiText(data).trim();
    const parsed = JSON.parse(text);
    
    // Clean up category
    let cleanedText = (parsed.category || "").replace(/^[#\*\s`'"\-\.]+|[#\*\s`'"\-\.]+$/g, "").trim();
    let found = cats.find((c) => c.toLowerCase() === cleanedText.toLowerCase());
    if (!found) {
      found = cats.find((c) => cleanedText.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(cleanedText.toLowerCase()));
    }
    parsed.category = found ?? "Lainnya";
    
    return {
      amount: Math.max(0, Math.round(Number(parsed.amount) || pendingTx.amount)),
      note: (parsed.note || pendingTx.note || "").slice(0, 80),
      category: parsed.category,
    };
  } catch (err) {
    console.error("Gagal parse balasan klarifikasi dengan AI:", err);
    return {
      amount: pendingTx.amount,
      note: pendingTx.note,
      category: pendingTx.category,
    };
  }
}

// ============================================================
// Panggil Gemini untuk merapikan catatan transaksi dari jawaban user
// ============================================================

export async function cleanClarifiedNote(
  apiKeys: string[],
  rawReply: string,
): Promise<string> {
  const prompt =
    `Kamu asisten keuangan pribadi. Rapikan dan perbaiki penulisan catatan transaksi dari jawaban user berikut agar menjadi keterangan barang/jasa/kegiatan yang singkat, bersih, dan jelas (kapitalisasi rapi, perbaiki typo, hapus kata-kata tidak penting/basa-basi seperti "buat bayar...", "itu tadi...", "untuk...", "sih", "deh").\n\n` +
    `Jawaban user: "${rawReply}"\n\n` +
    `Aturan:\n` +
    `- Jangan mengarang informasi baru yang tidak ada di jawaban user.\n` +
    `- Keluarkan HANYA hasil keterangannya saja yang sudah bersih, tanpa tanda kutip, tanpa penjelasan apapun.`;

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.2);
    const text = extractGeminiText(data).trim();
    return text.replace(/^["']|["']$/g, "") || rawReply;
  } catch {
    return rawReply;
  }
}

// ============================================================
// Panggil Gemini untuk re-klasifikasi kategori secara dinamis
// ============================================================

export async function reclassifyCategory(
  apiKeys: string[],
  note: string,
  type: "income" | "expense",
  expenseCats: string[],
  incomeCats: string[],
): Promise<string> {
  const cats = type === "expense" ? expenseCats : incomeCats;
  const prompt =
    `Kamu asisten klasifikasi transaksi keuangan. Klasifikasikan catatan transaksi berikut ke dalam salah satu kategori dari list yang diberikan.\n\n` +
    `Catatan transaksi: "${note}"\n` +
    `Tipe transaksi: ${type}\n` +
    `List kategori yang tersedia: [${cats.join(", ")}]\n\n` +
    `Aturan klasifikasi:\n` +
    `- "Makan": Khusus untuk makanan berat/pokok. Contoh: nasi, nugget, mie (mie ayam/mie goreng/indomie sebagai makanan berat), bakso, ayam geprek, lauk-pauk siap saji, dsb.\n` +
    `- "Jajan": Khusus untuk makanan/minuman ringan, camilan, minuman manis/kemasan. Contoh: es krim, kopi (instan/kemasan/kopi kekinian), ciki/snack, permen, cokelat, minuman manis/soda (Frestea, Sprite, dll), roti manis, dsb.\n` +
    `- "Sembako": Khusus untuk bahan mentah dapur dasar (minyak goreng, beras karung, gula pasir, garam, dsb).\n` +
    `- "Belanja": Khusus untuk kebutuhan rumah tangga non-konsumsi (seperti sabun mandi, detergen, pasta gigi, tisu, shampoo, sikat gigi, dsb).\n\n` +
    `Keluarkan HANYA nama kategori yang paling cocok (persis seperti yang tertulis di list kategori, misal: "Makan" atau "Jajan"). Jangan gunakan markdown code fence, jangan tambahkan kalimat lain.`;

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.1);
    const text = extractGeminiText(data).trim();
    let cleanedText = text.replace(/^[#\*\s`'"\-\.]+|[#\*\s`'"\-\.]+$/g, "").trim();
    cleanedText = cleanedText.replace(/^(kategori|category)\s*:\s*/i, "").trim();

    let found = cats.find((c) => c.toLowerCase() === cleanedText.toLowerCase());
    if (!found) {
      found = cats.find((c) => cleanedText.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(cleanedText.toLowerCase()));
    }
    return found ?? "Lainnya";
  } catch {
    return "Lainnya";
  }
}

// ============================================================
// Helper: today string (YYYY-MM-DD) di timezone WIB
// ============================================================

export function getTodayStr(): string {
  const now = new Date();
  // WIB = UTC+7
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}

// ============================================================
// Helper: format rupiah
// ============================================================

export function formatRupiah(amount: number): string {
  return "Rp" + Math.round(amount).toLocaleString("id-ID");
}

// ============================================================
// Helper: format tanggal Indonesia (12 Agustus 2026)
// ============================================================

const BULAN_ID = [
  "",
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export function formatTanggalID(dateStr: string): string {
  // dateStr: YYYY-MM-DD
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts.map(Number);
  const bulan = BULAN_ID[m] ?? String(m);
  return `${d} ${bulan} ${y}`;
}

// ============================================================
// Panggil Gemini untuk memverifikasi kecocokan barang di histori
// ============================================================

export async function matchHistoryAmountWithAi(
  apiKeys: string[],
  note: string,
  historyItems: { amount: number; note: string }[],
): Promise<number | null> {
  if (!historyItems.length) return null;
  
  const prompt =
    `Kamu asisten keuangan pribadi. Tugasmu adalah mencocokkan catatan transaksi baru dengan riwayat transaksi yang ada untuk mencari harga/nominal yang sesuai.\n\n` +
    `Catatan transaksi baru: "${note}"\n\n` +
    `Berikut adalah riwayat transaksi sebelumnya:\n` +
    historyItems.map((item, idx) => `${idx}. Note: "${item.note}", Amount: ${item.amount}`).join("\n") + "\n\n" +
    `Aturan pencocokan:\n` +
    `- Cari item/jasa yang memiliki makna atau nama yang sama (misal: "tisu", "tisue", "tissue" adalah sama; "nasi goreng ayam" dan "nasgor ayam" adalah sama).\n` +
    `- Nama toko/minimarket seperti "Alfamart", "Indomaret", "toko", "warung" di depan catatan adalah nama tempat, BUKAN nama barang. Jangan mencocokkan hanya karena nama tokonya sama (misal "Alfamart Tisu" TIDAK cocok dengan "Alfamart Makan" hanya karena sama-sama "Alfamart").\n` +
    `- Jika ada kecocokan barang/jasa yang satu makna/identik, kembalikan INDEX-nya saja (angka dari 0 sampai ${historyItems.length - 1}).\n` +
    `- Jika tidak ada yang cocok sama sekali, kembalikan kata "null".\n\n` +
    `Keluarkan HANYA index kecocokan (misal: "3") atau "null", jangan tambahkan kalimat lain.`;

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.15);
    const text = extractGeminiText(data).trim();
    if (text.toLowerCase() === "null") return null;
    const idx = parseInt(text, 10);
    if (!isNaN(idx) && idx >= 0 && idx < historyItems.length) {
      return historyItems[idx].amount;
    }
    return null;
  } catch {
    return null;
  }
}
