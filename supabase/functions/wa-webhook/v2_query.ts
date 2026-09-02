// supabase/functions/wa-webhook/v2_query.ts
// VERSI 2 - Pemrosesan Query Bebas / Tanya Apa Saja ("?")

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callGeminiRaw, extractGeminiText, getTodayStr, formatRupiah, formatTanggalID } from "./gemini.ts";
import {
  v2GetWallets,
  v2GetCategories,
  v2GetBudgets,
  v2GetSavingsGoals,
  v2GetDebtEntries,
  v2GetRecurringItems,
  v2GetTransactions,
  v2GetUserSettings
} from "./v2_db.ts";

// ============================================================
// RECURRING LOGIC IN WIB TIMEZONE (Mirroring index.html)
// ============================================================

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function recurringPeriodStart(dateStr: string, resetDay: number): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();

  const clampDay = (yy: number, mm: number) =>
    Math.min(resetDay, new Date(yy, mm + 1, 0).getDate());

  const cThis = clampDay(y, m);
  if (day >= cThis) return `${y}-${pad(m + 1)}-${pad(cThis)}`;

  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 11 : m - 1;
  return `${py}-${pad(pm + 1)}-${pad(clampDay(py, pm))}`;
}

function computeInitialDueDate(dayOfMonth: number, baseDateStr: string, resetDay: number): string {
  const startStr = recurringPeriodStart(baseDateStr, resetDay);
  const startDate = new Date(startStr + "T00:00:00");
  let y = startDate.getFullYear();
  let m = startDate.getMonth();

  if (dayOfMonth < resetDay) {
    m = m === 11 ? 0 : m + 1;
    if (m === 0) y++;
  }

  const d = Math.min(dayOfMonth, daysInMonth(y, m));
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function advanceDueDateOneMonth(dayOfMonth: number, currentDueStr: string): string {
  const cur = new Date(currentDueStr + "T00:00:00");
  const y = cur.getFullYear();
  const m = cur.getMonth();
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  const d = Math.min(dayOfMonth, daysInMonth(ny, nm));
  return `${ny}-${pad(nm + 1)}-${pad(d)}`;
}

export function getRecurringStatus(
  item: { day_of_month: number; last_confirmed_date: string | null },
  todayStr: string,
  resetDay: number
): { status: "sudah-dibayar" | "terlambat" | "jatuh-tempo" | "belum-bayar"; nextDue: string } {
  const currentPeriodStart = recurringPeriodStart(todayStr, resetDay);
  const lastPaidPeriod = item.last_confirmed_date
    ? recurringPeriodStart(item.last_confirmed_date, resetDay)
    : null;

  const isPaidThisPeriod = lastPaidPeriod === currentPeriodStart;
  const currentDue = computeInitialDueDate(item.day_of_month, todayStr, resetDay);

  if (isPaidThisPeriod) {
    return {
      status: "sudah-dibayar",
      nextDue: advanceDueDateOneMonth(item.day_of_month, currentDue),
    };
  }

  if (currentDue < todayStr) {
    return { status: "terlambat", nextDue: currentDue };
  } else if (currentDue === todayStr) {
    return { status: "jatuh-tempo", nextDue: currentDue };
  } else {
    return { status: "belum-bayar", nextDue: currentDue };
  }
}

// ============================================================
// MAIN QUERY PROCESSING FUNCTIONS
// ============================================================

const INDO_MONTHS = [
  "januari", "februari", "maret", "april", "mei", "juni",
  "juli", "agustus", "september", "oktober", "november", "desember"
];

function parseQueryMonth(text: string, todayStr: string): { monthStr: string; label: string; filterByMonth: boolean } {
  const lower = text.toLowerCase();

  // Cek kata kunci "semua data" atau "semua bulan" atau "semua transaksi"
  if (/\b(semua bulan|semua data|semua transaksi)\b/.test(lower)) {
    return { monthStr: "", label: "Semua Periode", filterByMonth: false };
  }

  const todayParts = todayStr.split("-");
  let targetYear = parseInt(todayParts[0], 10);
  let targetMonth = parseInt(todayParts[1], 10);

  // Cek jika ada penyebutan tahun (misal: 2025, 2026)
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    targetYear = parseInt(yearMatch[1], 10);
  }

  let foundMonthIdx = -1;
  for (let i = 0; i < INDO_MONTHS.length; i++) {
    if (lower.includes(INDO_MONTHS[i])) {
      foundMonthIdx = i;
      break;
    }
  }

  if (foundMonthIdx !== -1) {
    const formattedMonth = pad(foundMonthIdx + 1);
    const monthLabel = INDO_MONTHS[foundMonthIdx].charAt(0).toUpperCase() + INDO_MONTHS[foundMonthIdx].slice(1);
    return {
      monthStr: `${targetYear}-${formattedMonth}`,
      label: `${monthLabel} ${targetYear}`,
      filterByMonth: true
    };
  }

  // Cek kata "bulan lalu" atau "bulan kemaren"
  if (/\b(bulan lalu|bulan kemaren|bulan kemarin)\b/.test(lower)) {
    let prevMonth = targetMonth - 1;
    let prevYear = targetYear;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear--;
    }
    const formattedMonth = pad(prevMonth);
    const monthLabel = INDO_MONTHS[prevMonth - 1].charAt(0).toUpperCase() + INDO_MONTHS[prevMonth - 1].slice(1);
    return {
      monthStr: `${prevYear}-${formattedMonth}`,
      label: `${monthLabel} ${prevYear}`,
      filterByMonth: true
    };
  }

  // Default: bulan berjalan
  const currentMonthLabel = INDO_MONTHS[targetMonth - 1].charAt(0).toUpperCase() + INDO_MONTHS[targetMonth - 1].slice(1);
  return {
    monthStr: `${targetYear}-${pad(targetMonth)}`,
    label: `${currentMonthLabel} ${targetYear}`,
    filterByMonth: true
  };
}

export async function processV2Query(
  db: SupabaseClient,
  apiKeys: string[],
  userId: string,
  userQuestion: string,
  forNotifOnly = false,
): Promise<string> {
  const todayStr = getTodayStr(); // YYYY-MM-DD (WIB)
  const { monthStr, label: periodLabel, filterByMonth } = parseQueryMonth(userQuestion, todayStr);

  // 1. Dapatkan data dasar secara paralel
  const [wallets, categories, savingsGoals, debtEntries, recurringItems, allTransactions] = await Promise.all([
    v2GetWallets(db, userId),
    v2GetCategories(db, userId),
    v2GetSavingsGoals(db, userId),
    v2GetDebtEntries(db, userId),
    v2GetRecurringItems(db, userId),
    v2GetTransactions(db, userId)
  ]);

  // Default reset day untuk recurring/checklist
  const resetDay = 25;

  // Filter transaksi berdasarkan periode target
  let targetTransactions = allTransactions;
  if (filterByMonth && monthStr) {
    targetTransactions = allTransactions.filter(t => t.date && t.date.slice(0, 7) === monthStr);
  }

  // 2. Lakukan kalkulasi deterministik di backend (Anti-Hallucination)

  // a. Dompet & Saldo
  const sortedWallets = [...wallets].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
  const totalBalance = wallets.reduce((s, w) => s + (Number(w.balance) || 0), 0);

  // b. Ringkasan cash flow periode target
  const periodIncome = targetTransactions
    .filter(t => t.type === "income")
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const periodExpense = targetTransactions
    .filter(t => t.type === "expense")
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);

  // c. Breakdown pengeluaran per kategori
  const categorySpentMap: Record<string, number> = {};
  for (const t of targetTransactions) {
    if (t.type === "expense") {
      const catName = t.category || "Lainnya";
      categorySpentMap[catName] = (categorySpentMap[catName] || 0) + (Number(t.amount) || 0);
    }
  }

  // d. Budget & Sisa budget
  // Ambil data limit budget
  let budgets: any[] = [];
  if (filterByMonth && monthStr) {
    budgets = await v2GetBudgets(db, userId, monthStr);
  }
  const budgetStatusList = categories
    .filter(c => c.type === "expense")
    .map(c => {
      const budgetLimit = budgets.find(b => b.category_id === c.id);
      const limitAmt = budgetLimit ? Number(budgetLimit.limit_amount) : null;
      const spentAmt = categorySpentMap[c.name] || 0;
      const remainingAmt = limitAmt !== null ? limitAmt - spentAmt : null;
      return {
        category_id: c.id,
        category_name: c.name,
        has_limit: limitAmt !== null,
        limit: limitAmt,
        spent: spentAmt,
        remaining: remainingAmt
      };
    });

  // e. Rata-rata harian per kategori (berdasarkan hari yang sudah berjalan di bulan berjalan, maks hari total bulan itu)
  let daysPassed = 1;
  const todayParts = todayStr.split("-");
  const currentMonthStr = `${todayParts[0]}-${todayParts[1]}`;
  
  if (filterByMonth && monthStr === currentMonthStr) {
    daysPassed = Math.max(1, parseInt(todayParts[2], 10));
  } else if (filterByMonth && monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    daysPassed = daysInMonth(y, m - 1);
  } else {
    daysPassed = 30; // Fallback jika semua periode
  }

  const categoryDailyAverage = Object.entries(categorySpentMap).map(([name, amount]) => {
    return {
      category_name: name,
      total_spent: amount,
      daily_average: Math.round(amount / daysPassed)
    };
  });

  // f. Goals Tabungan & progress
  const goalsProgressList = savingsGoals.map(g => {
    const targetAmt = Number(g.target_amount) || 0;
    const linkedWallet = wallets.find(w => w.id === g.wallet_id);
    const progressAmt = linkedWallet ? Number(linkedWallet.balance) : 0;
    const pct = targetAmt > 0 ? Math.round((progressAmt / targetAmt) * 100) : 0;
    return {
      goal_name: g.name,
      target_amount: targetAmt,
      progress_amount: progressAmt,
      progress_percentage: pct,
      target_date: g.target_date ? formatTanggalID(g.target_date) : "-"
    };
  });

  // g. Utang Piutang per orang
  const activeDebts = debtEntries.filter(d => d.status === "active" || d.status === "belum");
  const debtSummaryMap: Record<string, { I_owe: number; owes_me: number }> = {};
  for (const d of activeDebts) {
    const person = d.person_name;
    debtSummaryMap[person] = debtSummaryMap[person] || { I_owe: 0, owes_me: 0 };
    const amt = Number(d.amount) || 0;
    if (d.type === "i_owe" || d.type === "utang") {
      debtSummaryMap[person].I_owe += amt;
    } else {
      debtSummaryMap[person].owes_me += amt;
    }
  }
  const debtList = Object.entries(debtSummaryMap).map(([name, val]) => ({
    person_name: name,
    I_owe: val.I_owe,
    owes_me: val.owes_me
  }));
  const totalUtang = activeDebts
    .filter(d => d.type === "i_owe" || d.type === "utang")
    .reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const totalPiutang = activeDebts
    .filter(d => d.type === "owed_to_me" || d.type === "piutang")
    .reduce((s, d) => s + (Number(d.amount) || 0), 0);

  // h. Checklist/Recurring Status
  const checklistList = recurringItems.map(item => {
    const { status, nextDue } = getRecurringStatus(item, todayStr, resetDay);
    const linkedWallet = wallets.find(w => w.id === item.wallet_id);
    return {
      item_name: item.name,
      type: item.type,
      amount: Number(item.amount) || 0,
      wallet_name: linkedWallet ? linkedWallet.name : "-",
      day_of_month: item.day_of_month,
      active: item.active !== false,
      status: status,
      next_due_date: formatTanggalID(nextDue)
    };
  });

  // i. Transaksi Terbesar
  const largestTransactions = [...targetTransactions]
    .filter(t => t.type === "expense")
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    .slice(0, 5)
    .map(t => ({
      date: t.date ? formatTanggalID(t.date) : "-",
      amount: Number(t.amount) || 0,
      category: t.category || "Lainnya",
      note: t.note || "-"
    }));

  // 3. Susun data riil ke dalam structured context untuk AI
  const realFinancialContext = {
    konteks_waktu: {
      tanggal_hari_ini: formatTanggalID(todayStr),
      periode_laporan: periodLabel,
      jumlah_hari_berjalan_dalam_periode: daysPassed
    },
    dompet_dan_saldo: {
      daftar_dompet: sortedWallets.map(w => ({ nama: w.name, saldo: formatRupiah(w.balance) })),
      total_saldo_semua_dompet: formatRupiah(totalBalance)
    },
    ringkasan_arus_kas_periode: {
      total_pemasukan: formatRupiah(periodIncome),
      total_pengeluaran: formatRupiah(periodExpense),
      selisih_bersih: formatRupiah(periodIncome - periodExpense)
    },
    breakdown_pengeluaran_per_kategori: Object.entries(categorySpentMap).map(([name, val]) => ({
      kategori: name,
      total_pengeluaran: formatRupiah(val)
    })),
    status_budget_anggaran: budgetStatusList.map(b => ({
      kategori: b.category_name,
      ada_limit: b.has_limit ? "Ya" : "Tidak",
      limit_budget: b.has_limit ? formatRupiah(b.limit || 0) : "Belum ada limit",
      terpakai: formatRupiah(b.spent),
      sisa_budget: b.has_limit ? formatRupiah(b.remaining || 0) : "N/A"
    })),
    rata_rata_pengeluaran_harian: {
      per_kategori: categoryDailyAverage.map(a => ({
        kategori: a.category_name,
        total_pengeluaran: formatRupiah(a.total_spent),
        rata_rata_harian: `${formatRupiah(a.daily_average)} / hari`
      })),
      total_rata_rata_harian_keseluruhan: `${formatRupiah(categoryDailyAverage.reduce((s, a) => s + a.daily_average, 0))} / hari`
    },
    tujuan_tabungan: goalsProgressList.map(g => ({
      nama_tujuan: g.goal_name,
      target_nominal: formatRupiah(g.target_amount),
      progress_saat_ini: `${formatRupiah(g.progress_amount)} (${g.progress_percentage}%)`,
      tanggal_target: g.target_date
    })),
    utang_piutang: {
      daftar_per_orang: debtList.map(d => ({
        nama: d.person_name,
        utang_saya_ke_dia: formatRupiah(d.I_owe),
        utang_dia_ke_saya: formatRupiah(d.owes_me)
      })),
      total_utang_saya: formatRupiah(totalUtang),
      total_piutang_saya: formatRupiah(totalPiutang)
    },
    daftar_transaksi_rutin_berulang: checklistList.map(c => ({
      nama_item: c.item_name,
      jenis_transaksi: c.type === "income" ? "Pemasukan Rutin (Uang Masuk / Gaji / Terima)" : "Pengeluaran Rutin / Tagihan (Uang Keluar / Bayar)",
      nominal: formatRupiah(c.amount),
      status_pembayaran: c.status === "sudah-dibayar" ? "Sudah Selesai (Dibayar/Diterima)" : (c.status === "terlambat" ? "TERLAMBAT" : (c.status === "jatuh-tempo" ? "Jatuh Tempo Hari Ini" : "Belum Selesai (Belum Bayar/Terima)")),
      tanggal_jatuh_tempo_berikutnya: c.next_due_date
    })),
    pengeluaran_terbesar: largestTransactions.map((t, idx) => ({
      nomor: idx + 1,
      tanggal: t.date,
      nominal: formatRupiah(t.amount),
      kategori: t.category,
      keterangan: t.note
    })),
    daftar_transaksi_detail: targetTransactions.map(t => {
      const linkedWallet = wallets.find(w => w.id === t.wallet_id);
      return {
        tanggal: t.date ? formatTanggalID(t.date) : "-",
        jenis: t.type === "income" ? "Pemasukan" : (t.type === "expense" ? "Pengeluaran" : "Transfer"),
        nominal: formatRupiah(Number(t.amount) || 0),
        kategori: t.category || "-",
        dompet: linkedWallet ? linkedWallet.name : "-",
        catatan: t.note || "-"
      };
    })
  };

  // 4. Tahap perangkaian bahasa via Gemini AI dengan instruksi anti-halusinasi ketat
  const promptText = `
Kamu asisten pencatatan keuangan pribadi pintar lewat WhatsApp. Jawab pertanyaan user mengenai laporan keuangan mereka hanya menggunakan data riil yang disediakan di bawah ini.

ATURAN UMUM KEMAMPUAN ANALISIS, KALKULASI & PERBANDINGAN:
- AI tidak boleh bertindak sekadar sebagai 'penyaji data mentah' yang menyodorkan seluruh data tanpa diolah. Kamu adalah asisten analis keuangan pribadi yang pintar.
- Jika user menanyakan perbandingan (misal: "lebih besar mana pengeluaran bulan ini dibanding bulan lalu?", "kategori apa yang paling boros?", "apakah saldo saya naik?"), bandingkan nilai-nilainya secara matematis, hitung selisihnya jika relevan, lalu simpulkan dengan jelas dan langsung menjawab intinya.
- Jika user meminta penggabungan, total, rata-rata, pengelompokan, atau kalkulasi tertentu (misal: "gabungan makan + jajan", "total sisa budget saya berapa?", "utang saya ke Budi dikurangi piutang ke dia sisa berapa?"), lakukan kalkulasi matematis menggunakan data dasar yang disediakan di DATA_FINANSIAL_RIIL.
- Aturan analisis dan pengolahan ini berlaku secara umum untuk semua topik data: saldo dompet, transaksi, limit anggaran/budget, utang-piutang, tabungan, tagihan recurring, dan rata-rata harian. Jangan membatasi logika ini hanya pada satu kasus saja.
- Jangan pernah menjawab "data tidak tersedia" atau "tidak tercatat di sistem" jika jawaban tersebut sebenarnya bisa diperoleh dengan melakukan kalkulasi matematika sederhana (penjumlahan, pengurangan, perbandingan) terhadap angka-angka yang ada di DATA_FINANSIAL_RIIL.

ATURAN ANTI-HALUSINASI:
1. Semua data dasar (nominal transaksi dasar, nama dompet, nama kategori, dll.) HARUS berasal dari DATA_FINANSIAL_RIIL di bawah ini. Jangan pernah mengarang data dasar yang tidak ada.
2. Kamu DIPERBOLEHKAN dan DIHARAPKAN melakukan kalkulasi aritmatika (menjumlahkan, mengurangi, mengalikan, membagi, mencari rata-rata, menggabungkan) terhadap data-data dasar tersebut untuk menjawab pertanyaan user secara akurat.
3. Yang DILARANG hanyalah: mengarang data/transaksi fiktif yang tidak tercantum, atau mengklaim angka dasar di luar yang tertulis pada DATA_FINANSIAL_RIIL.
4. Jawab dalam bahasa Indonesia yang natural dan santai. Boleh panjang jika memang dibutuhkan untuk kejelasan analisis.
5. Jangan gunakan emoji apa pun kecuali jika user meminta secara khusus di pertanyaannya.
6. Selalu format angka nominal menggunakan Rp (Rupiah) dengan pemisah ribuan (titik).

ATURAN ANALISIS & PENYIMPULAN:
- Pahami MAKSUD pertanyaan user. Jika user bertanya "total", "keseluruhan", "gabungan", "digabung", "selisih", dll., berikan satu angka/nilai kesimpulan hasil kalkulasi tersebut sebagai jawaban utama di kalimat pertama.
- Berikan rincian detail angka per kategori/item sebagai data pendukung/penjelasan setelah kamu menyajikan jawaban utama. JANGAN balik urutannya (data mentah dulu baru kesimpulan), dan jangan hanya menampilkan rinciannya saja tanpa total/kalkulasi yang ditanyakan.
- Tentukan sendiri format terbaik demi keterbacaan tinggi. Prioritaskan keterbacaan langsung.

ATURAN FORMAT JAWABAN:
- Jika jawaban mencakup beberapa item/transaksi/kategori terpisah (misal: daftar transaksi hari ini, daftar pengeluaran kemarin, daftar tagihan), gunakan format LIST BERNOMOR agar mudah dibaca. Contoh:
  Hari ini ada 3 pengeluaran dari Dompet Utama:
  1. Pulsa & Internet: Rp85.470 (berlangganan antigrafity)
  2. Pulsa & Internet: Rp3.700 (Pembayaran QR Axis)
  3. Bensin: Rp38.000 (Bensin)
- Jika jawaban lebih cocok naratif (misal: ringkasan saldo, total pengeluaran bulan ini, perbandingan 2 angka), gunakan format paragraf biasa.
- Kalimat pembuka sebelum list HARUS natural dan menyesuaikan konteks pertanyaan — JANGAN gunakan template tetap. Misalnya: kalau ditanya "hari ini ada berapa transaksi", fokus ke jumlah; kalau ditanya "belanja apa aja kemarin", fokus ke daftar belanja. Variasikan kalimat pembukanya.
- Kamu yang menentukan format mana yang paling pas untuk setiap jawaban — tidak ada aturan mutlak. Prioritaskan keterbacaan.

${forNotifOnly ? `
ATURAN KHUSUS MODE NOTIFIKASI (Balasan WA sedang NONAKTIF):
- Jawaban Anda HANYA akan tampil di jendela notifikasi push HP yang berukuran sangat sempit.
- WAJIB TEPAT 1 KALIMAT TUNTAS & PADAT (Maksimal 15-20 kata, di bawah 120 karakter).
- LANGSUNG sebutkan kesimpulan angka/faktanya saja secara padat tanpa pengantar panjang.
  Contoh BENAR: "Pengeluaran rata-rata harian kamu di bulan Agustus 2026 adalah Rp315.747 per hari."
  Contoh BENAR: "Total pengeluaran makan kamu di bulan ini adalah Rp1.250.000."
  Contoh BENAR: "Saldo Dompet Utama kamu saat ini adalah Rp2.500.000."
- DILARANG KERAS:
  * DILARANG membuat kalimat kedua (JANGAN beri penawaran detail seperti "Jika ingin melihat lebih detail...", "Berikut rincian...", "Ada yang bisa dibantu?", dll.).
  * DILARANG menggunakan list, bullet points, atau baris baru (line break).
  * DILARANG membuat kalimat yang menggantung/bersambung. Kalimat HARUS selesai tuntas dan diakhiri titik.
- Abaikan instruksi "boleh panjang", rincian kategori pendukung, dan aturan format list di atas selama dalam mode notifikasi ini.
` : ""}
DATA_FINANSIAL_RIIL:
${JSON.stringify(realFinancialContext, null, 2)}

PERTANYAAN_USER:
"${userQuestion}"
`;

  try {
    const data = await callGeminiRaw(apiKeys, [{ text: promptText }], 0.15);
    const text = extractGeminiText(data);
    return text.trim();
  } catch (err) {
    console.error("Error in processV2Query generate response:", err);
    return "Maaf, saat ini asisten tidak dapat memproses laporan. Silakan coba beberapa saat lagi.";
  }
}
