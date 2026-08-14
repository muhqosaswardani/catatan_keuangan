// supabase/functions/wa-webhook/v2_modes.ts
// VERSI 2 - Logika Mode Terkunci: Koreksi, Limit, Tujuan (Revisi Bug & Layout)

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callGeminiRaw, extractGeminiText, getTodayStr, formatRupiah, formatTanggalID } from "./gemini.ts";
import { sendWhatsAppMessage, downloadWhatsAppMedia } from "./whatsapp.ts";
import {
  v2GetWallets,
  v2GetCategories,
  v2GetBudgets,
  v2GetSavingsGoals,
  saveV2Session,
  clearV2Session
} from "./v2_db.ts";

const PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;
const ACCESS_CODE = Deno.env.get("WA_ACCESS_CODE") ?? "";

// ============================================================
// CLARIFICATION UTILITY FOR AMBIGUITY
// ============================================================

function findWalletByName(name: string, wallets: any[]): any[] {
  const lower = name.toLowerCase();
  return wallets.filter(w => w.name.toLowerCase().includes(lower));
}

function findCategoryByName(name: string, categories: any[]): any[] {
  const lower = name.toLowerCase();
  return categories.filter(c => c.name.toLowerCase().includes(lower));
}

function findGoalByName(name: string, goals: any[]): any[] {
  const lower = name.toLowerCase();
  return goals.filter(g => g.name.toLowerCase().includes(lower));
}

// ============================================================
// GEMINI ACTION PARSERS
// ============================================================

async function parseKoreksiAction(
  apiKeys: string[],
  text: string,
  mediaParts: any[],
  wallets: any[],
  draftItems: any[]
): Promise<any> {
  const prompt = `
Kamu asisten Mode Koreksi Saldo. Berdasarkan kalimat user (atau foto cash/uang jika dilampirkan), tentukan tindakannya terhadap draft koreksi saat ini.
Daftar dompet tersedia: [${wallets.map(w => w.name).join(", ")}]
Draft saat ini:
${draftItems.map((it, idx) => `${idx + 1}. Wallet: ${it.wallet_name}, Actual: ${it.amount}`).join("\n")}

Aksi yang mungkin:
1. "add" - Menambah item dompet baru ke draft (misal: "tambah shopeepay 50rb").
2. "edit" - Mengubah nominal dompet yang sudah ada di draft (misal: "gopay 15rb", "1 15rb").
3. "delete" - Menghapus item dompet dari draft (bukan dari database!) (misal: "hapus gopay", "hapus 1").
4. "none" - Tidak dikenali.

Keluarkan JSON dengan schema:
{
  "action": "add" | "edit" | "delete" | "none",
  "wallet_name": "string (nama dompet yang disebut, kosongkan jika tidak ada)",
  "amount": number | null,
  "index": number | null // 1-indexed nomor urut jika user merujuk ke nomor urut draft
}
`;

  const parts = [{ text: prompt }];
  if (text) {
    parts.push({ text: `Kalimat user: "${text}"` });
  }
  if (mediaParts.length > 0) {
    parts.push(...mediaParts);
  }

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "edit", "delete", "none"] },
        wallet_name: { type: "STRING" },
        amount: { type: "NUMBER" },
        index: { type: "NUMBER" }
      },
      required: ["action"]
    };

    const data = await callGeminiRaw(apiKeys, parts, 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    return JSON.parse(resultText);
  } catch (err) {
    console.error("Error in parseKoreksiAction:", err);
    return { action: "none" };
  }
}

async function parseLimitAction(
  apiKeys: string[],
  text: string,
  categories: any[],
  budgets: any[]
): Promise<any> {
  const prompt = `
Kamu asisten Mode Limit Anggaran. Berdasarkan kalimat user, tentukan tindakan perubahan limit anggaran kategori untuk bulan ini.
Daftar kategori tersedia: [${categories.map(c => c.name).join(", ")}]
Daftar limit saat ini:
${budgets.map((b, idx) => `${idx + 1}. Kategori: ${b.category_name}, Limit: ${b.limit}`).join("\n")}

Aksi yang mungkin:
1. "add" - Menambah limit kategori baru (misal: "tambah Transportasi 300rb").
2. "edit" - Mengubah nominal limit kategori yang ada (misal: "edit 1 1jt", "edit Makan 1.2jt").
3. "delete" - Menghapus limit kategori (misal: "hapus Makan", "hapus 1").
4. "none" - Tidak dikenali.

Keluarkan JSON dengan schema:
{
  "action": "add" | "edit" | "delete" | "none",
  "category_name": "string (nama kategori)",
  "amount": number | null,
  "index": number | null // 1-indexed nomor urut jika user merujuk ke nomor urut list
}
`;

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "edit", "delete", "none"] },
        category_name: { type: "STRING" },
        amount: { type: "NUMBER" },
        index: { type: "NUMBER" }
      },
      required: ["action"]
    };

    const data = await callGeminiRaw(apiKeys, [{ text: prompt }, { text: `Kalimat user: "${text}"` }], 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    return JSON.parse(resultText);
  } catch (err) {
    console.error("Error in parseLimitAction:", err);
    return { action: "none" };
  }
}

async function parseTujuanAction(
  apiKeys: string[],
  text: string,
  goals: any[]
): Promise<any> {
  const prompt = `
Kamu asisten Mode Tujuan Tabungan. Berdasarkan kalimat user, tentukan tindakan perubahan tujuan tabungan.
Daftar tujuan tabungan saat ini:
${goals.map((g, idx) => `${idx + 1}. Tujuan: ${g.goal_name}, Target: ${g.target_amount}`).join("\n")}

Aksi yang mungkin:
1. "add" - Menambah tujuan tabungan baru (misal: "tambah Mobil target 150jt").
2. "edit" - Mengubah target nominal atau tanggal tujuan yang ada (misal: "edit 1 target 12jt", "edit Laptop target 10jt").
3. "delete" - Menghapus tujuan tabungan (misal: "hapus Laptop", "hapus 1").
4. "none" - Tidak dikenali.

Keluarkan JSON dengan schema:
{
  "action": "add" | "edit" | "delete" | "none",
  "goal_name": "string (nama tujuan/goal)",
  "amount": number | null,
  "index": number | null // 1-indexed nomor urut jika user merujuk ke nomor urut list
}
`;

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", enum: ["add", "edit", "delete", "none"] },
        goal_name: { type: "STRING" },
        amount: { type: "NUMBER" },
        index: { type: "NUMBER" }
      },
      required: ["action"]
    };

    const data = await callGeminiRaw(apiKeys, [{ text: prompt }, { text: `Kalimat user: "${text}"` }], 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    return JSON.parse(resultText);
  } catch (err) {
    console.error("Error in parseTujuanAction:", err);
    return { action: "none" };
  }
}

// ============================================================
// MODE 1: KOREKSI SALDO
// ============================================================

export async function handleModeKoreksiEnter(
  db: SupabaseClient,
  waChatId: string,
  messageId: string
): Promise<void> {
  const wallets = await v2GetWallets(db, ACCESS_CODE);
  let text = `*Mode Koreksi Saldo* (Cek) ✓
Kirim foto uang fisik atau ketik koreksi saldo dompetmu (contoh: 'gopay 50rb', 'cash 20rb').

Daftar Dompet Saat Ini:
${wallets.map(w => `- ${w.name}: ${formatRupiah(w.balance)}`).join("\n")}

Ketik 'batal' untuk keluar dari mode.`;

  await saveV2Session(db, waChatId, ACCESS_CODE, "koreksi", { items: [] });
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeKoreksiMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Mode koreksi dibatalkan. Tidak ada perubahan saldo.`, msg.messageId);
    return;
  }

  const draftItems = session.session_data.items || [];
  const wallets = await v2GetWallets(db, ACCESS_CODE);

  if (cleaned === "ya" || cleaned === "oke") {
    if (draftItems.length === 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Draft koreksi kosong. Silakan kirim data koreksi dulu atau ketik 'batal' untuk keluar.`, msg.messageId);
      return;
    }

    // Eksekusi koreksi saldo (Penyesuaian Saldo)
    // Cari kategori Penyesuaian Saldo
    const { data: categories } = await db.from("categories").select("*").eq("access_code", ACCESS_CODE);
    let catExpense = categories?.find(c => c.name === "Penyesuaian Saldo" && c.type === "expense");
    let catIncome = categories?.find(c => c.name === "Penyesuaian Saldo" && c.type === "income");

    if (!catExpense) {
      const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("categories").insert({ id: catId, access_code: ACCESS_CODE, name: "Penyesuaian Saldo", type: "expense", icon: "sliders", color: "#6b7280" });
      catExpense = { id: catId, name: "Penyesuaian Saldo" };
    }
    if (!catIncome) {
      const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("categories").insert({ id: catId, access_code: ACCESS_CODE, name: "Penyesuaian Saldo", type: "income", icon: "sliders", color: "#6b7280" });
      catIncome = { id: catId, name: "Penyesuaian Saldo" };
    }

    const todayStr = getTodayStr();

    for (const item of draftItems) {
      const wallet = wallets.find(w => w.id === item.wallet_id);
      if (!wallet) continue;
      
      const currentBalance = Number(wallet.balance) || 0;
      const actualBalance = Number(item.amount) || 0;
      const diff = actualBalance - currentBalance;

      if (diff === 0) continue;

      const txType = diff < 0 ? "expense" : "income";
      const catId = diff < 0 ? catExpense.id : catIncome.id;
      const adjustAmount = Math.abs(diff);

      const txId = `wa_tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("transactions").insert({
        id: txId,
        access_code: ACCESS_CODE,
        wallet_id: wallet.id,
        category_id: catId,
        category: "Penyesuaian Saldo",
        type: txType,
        amount: adjustAmount,
        date: todayStr,
        note: `Koreksi saldo WA`,
        source: "whatsapp",
        updated_at: new Date().toISOString()
      });
    }

    // Recalculate balances
    const { data: rawWallets } = await db.from("wallets").select("*").eq("access_code", ACCESS_CODE);
    const { data: transactions } = await db.from("transactions").select("*").eq("access_code", ACCESS_CODE);
    if (rawWallets && transactions) {
      const sums: Record<string, number> = {};
      for (const w of rawWallets) sums[w.id] = 0;
      for (const t of transactions) {
        if (t.date > todayStr) continue;
        const amt = Number(t.amount) || 0;
        if (t.type === "expense") {
          if (sums[t.wallet_id] !== undefined) sums[t.wallet_id] -= amt;
        } else if (t.type === "income") {
          if (sums[t.wallet_id] !== undefined) sums[t.wallet_id] += amt;
        } else if (t.type === "transfer") {
          if (sums[t.wallet_id] !== undefined) sums[t.wallet_id] -= amt;
          if (sums[t.to_wallet_id] !== undefined) sums[t.to_wallet_id] += amt;
        }
      }
      const { data: settings } = await db.from("user_settings").select("nav_config").eq("access_code", ACCESS_CODE).maybeSingle();
      const initialBalances = settings?.nav_config?.initialBalances || {};
      for (const w of rawWallets) {
        const newBalance = (Number(initialBalances[w.id]) || 0) + (sums[w.id] || 0);
        await db.from("wallets").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("id", w.id);
      }
    }

    const { data: finalWallets } = await db.from("wallets").select("*").eq("access_code", ACCESS_CODE);
    let confirmText = `Koreksi saldo berhasil disimpan! ✓\n\n`;
    draftItems.forEach((item: any) => {
      const w = finalWallets?.find(x => x.id === item.wallet_id);
      confirmText += `${item.wallet_name}: ${formatRupiah(w?.balance ?? 0)}\n`;
    });

    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, confirmText, msg.messageId);
    return;
  }

  // Parse media (foto cash)
  const mediaParts: any[] = [];
  if (msg.type === "image" && msg.mediaId) {
    try {
      const { data, mimeType } = await downloadWhatsAppMedia(msg.mediaId, WA_ACCESS_TOKEN);
      const base64 = btoa(String.fromCharCode(...data));
      mediaParts.push({ inlineData: { data: base64, mimeType } });
    } catch (e) {
      console.error("Gagal download foto koreksi:", e);
    }
  }

  // Panggil AI untuk parsing tindakan koreksi
  const parsedAction = await parseKoreksiAction(apiKeys, text, mediaParts, wallets, draftItems);

  if (parsedAction.action === "none" && mediaParts.length === 0) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Perintah tidak dipahami. Silakan sebut nama dompet dan nominal (misal: 'cash 50rb', 'hapus 1', atau kirim foto uang cash).`,
      msg.messageId
    );
    return;
  }

  let updatedDraft = [...draftItems];

  if (parsedAction.action === "delete") {
    let deletedIdx = -1;
    if (parsedAction.index !== null) {
      deletedIdx = parsedAction.index - 1;
    } else if (parsedAction.wallet_name) {
      deletedIdx = updatedDraft.findIndex(d => d.wallet_name.toLowerCase().includes(parsedAction.wallet_name.toLowerCase()));
    }

    if (deletedIdx >= 0 && deletedIdx < updatedDraft.length) {
      const removed = updatedDraft.splice(deletedIdx, 1)[0];
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Dihapus dari draft: ${removed.wallet_name}`, msg.messageId);
    } else {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Item draft tidak ditemukan.`, msg.messageId);
      return;
    }
  } else if (parsedAction.action === "add" || parsedAction.action === "edit") {
    if (!parsedAction.wallet_name) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Mohon sebutkan nama dompet yang jelas.`, msg.messageId);
      return;
    }

    const matches = findWalletByName(parsedAction.wallet_name, wallets);
    if (matches.length === 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Dompet "${parsedAction.wallet_name}" tidak ditemukan.`, msg.messageId);
      return;
    }
    if (matches.length > 1) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Nama dompet ambigu. Pilihan:\n` + matches.map((w, idx) => `${idx + 1}. ${w.name}`).join("\n") + `\n\nMohon ketik ulang dengan nama dompet yang spesifik.`,
        msg.messageId
      );
      return;
    }

    const targetWallet = matches[0];
    const amount = parsedAction.amount ?? 0;

    const existingIdx = updatedDraft.findIndex(d => d.wallet_id === targetWallet.id);
    if (existingIdx >= 0) {
      updatedDraft[existingIdx].amount = amount;
    } else {
      updatedDraft.push({
        wallet_id: targetWallet.id,
        wallet_name: targetWallet.name,
        amount
      });
    }
  }

  // Simpan sesi terupdate
  await saveV2Session(db, waChatId, ACCESS_CODE, "koreksi", { items: updatedDraft });

  // Cetak draft terupdate
  let report = `📋 *Draft Koreksi Saldo*\n\n`;
  if (updatedDraft.length === 0) {
    report += `(kosong)\n`;
  } else {
    updatedDraft.forEach((item, idx) => {
      const orig = wallets.find(w => w.id === item.wallet_id);
      const systemBalance = orig ? Number(orig.balance) : 0;
      const diff = item.amount - systemBalance;
      const diffStr = diff === 0 ? "Rp0" : (diff < 0 ? `-${formatRupiah(Math.abs(diff))}` : `+${formatRupiah(diff)}`);
      
      report += `${idx + 1}. ${item.wallet_name}\n` +
                `   Saldo sistem : ${formatRupiah(systemBalance)}\n` +
                `   Saldo aktual : ${formatRupiah(item.amount)}\n` +
                `   Selisih      : ${diffStr}\n\n`;
    });
  }

  report += `Ketik nama/nomor + nilai baru untuk edit, "tambah [dompet] [nilai]" untuk tambah dompet lain, "hapus [nomor/nama]" untuk hapus salah satu.\n\n` +
            `Ketik *"ya"* untuk proses semua koreksi di atas, atau *"batal"* untuk keluar tanpa perubahan.`;
            
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, report, msg.messageId);
}

// ============================================================
// MODE 2: LIMIT BUDGET
// ============================================================

async function renderLimitList(db: SupabaseClient, categories: any[]): Promise<string> {
  const todayStr = getTodayStr();
  const currentMonth = todayStr.slice(0, 7);
  const budgets = await v2GetBudgets(db, ACCESS_CODE, currentMonth);

  // Dapatkan total pengeluaran per kategori di bulan berjalan
  const { data: transactions } = await db
    .from("transactions")
    .select("category, amount")
    .eq("access_code", ACCESS_CODE)
    .eq("type", "expense")
    .gte("date", `${currentMonth}-01`)
    .lte("date", todayStr);

  const spentMap: Record<string, number> = {};
  transactions?.forEach(t => {
    spentMap[t.category] = (spentMap[t.category] || 0) + (Number(t.amount) || 0);
  });

  const monthLabel = formatTanggalID(todayStr).split(" ").slice(1).join(" "); // e.g. "Agustus 2026"
  let text = `Daftar Limit Anggaran (${monthLabel}):\n\n`;

  const expenseCats = categories.filter(c => c.type === "expense");

  expenseCats.forEach((c, idx) => {
    const b = budgets.find(b => b.category_id === c.id);
    const limit = b ? Number(b.limit_amount) : null;
    const spent = spentMap[c.name] || 0;
    const remaining = limit !== null ? limit - spent : null;

    text += `${idx + 1}. ${c.name}\n`;
    if (limit !== null) {
      text += `   Limit    : ${formatRupiah(limit)}\n` +
              `   Terpakai : ${formatRupiah(spent)}\n` +
              `   Sisa     : ${formatRupiah(remaining || 0)}\n\n`;
    } else {
      text += `   Belum ada limit\n\n`;
    }
  });

  text += `Mau tambah, edit, atau hapus yang mana?\n` +
    `- Edit: 'edit 1 1.2jt' atau 'edit Makan 1.2jt'\n` +
    `- Tambah: 'tambah Transportasi 300rb' (jika belum ada limit)\n` +
    `- Hapus: 'hapus 1' atau 'hapus Makan'\n\n` +
    `Ketik 'batal' untuk keluar.`;

  return text;
}

export async function handleModeLimitEnter(
  db: SupabaseClient,
  waChatId: string,
  messageId: string
): Promise<void> {
  const categories = await v2GetCategories(db, ACCESS_CODE);
  const text = await renderLimitList(db, categories);
  
  await saveV2Session(db, waChatId, ACCESS_CODE, "limit", {});
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeLimitMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Keluar dari mode limit anggaran.`, msg.messageId);
    return;
  }

  const categories = await v2GetCategories(db, ACCESS_CODE);
  const todayStr = getTodayStr();
  const currentMonth = todayStr.slice(0, 7);
  const budgets = await v2GetBudgets(db, ACCESS_CODE, currentMonth);

  const expenseCats = categories.filter(c => c.type === "expense");
  const budgetList = expenseCats.map(c => {
    const b = budgets.find(b => b.category_id === c.id);
    return {
      category_id: c.id,
      category_name: c.name,
      limit: b ? Number(b.limit_amount) : null,
      budget_id: b ? b.id : null
    };
  });

  const parsedAction = await parseLimitAction(apiKeys, text, categories, budgetList);

  if (parsedAction.action === "none") {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Perintah tidak dipahami. Silakan gunakan format 'edit/tambah/hapus' (contoh: 'edit 1 1jt', 'hapus 2').`,
      msg.messageId
    );
    return;
  }

  let targetCat = null;

  if (parsedAction.index !== null) {
    const idx = parsedAction.index - 1;
    if (idx >= 0 && idx < budgetList.length) {
      targetCat = budgetList[idx];
    }
  } else if (parsedAction.category_name) {
    const matches = findCategoryByName(parsedAction.category_name, expenseCats);
    if (matches.length === 1) {
      targetCat = budgetList.find(b => b.category_id === matches[0].id);
    } else if (matches.length > 1) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Nama kategori ambigu. Pilihan:\n` + matches.map((c, idx) => `${idx + 1}. ${c.name}`).join("\n") + `\n\nMohon ketik ulang perintah dengan nama kategori spesifik.`,
        msg.messageId
      );
      return;
    }
  }

  if (!targetCat) {
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Kategori tidak ditemukan.`, msg.messageId);
    return;
  }

  const amount = parsedAction.amount ?? 0;

  if (parsedAction.action === "delete") {
    if (targetCat.budget_id) {
      await db.from("budgets").delete().eq("id", targetCat.budget_id);
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Limit anggaran untuk kategori "${targetCat.category_name}" berhasil dihapus.`, msg.messageId);
    } else {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Kategori "${targetCat.category_name}" memang belum memiliki limit.`, msg.messageId);
    }
  } else if (parsedAction.action === "add" || parsedAction.action === "edit") {
    if (amount <= 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Nominal limit tidak valid.`, msg.messageId);
      return;
    }

    if (targetCat.budget_id) {
      // Edit
      await db
        .from("budgets")
        .update({
          limit_amount: amount,
          updated_at: new Date().toISOString()
        })
        .eq("id", targetCat.budget_id);
    } else {
      // Add new
      const bId = `wa_b_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("budgets").insert({
        id: bId,
        access_code: ACCESS_CODE,
        category_id: targetCat.category_id,
        month: currentMonth,
        limit_amount: amount,
        updated_at: new Date().toISOString()
      });
    }

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Limit anggaran kategori "${targetCat.category_name}" disimpan senilai ${formatRupiah(amount)}.`,
      msg.messageId
    );
  }

  // Cetak ulang list terupdate
  const updatedText = await renderLimitList(db, categories);
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Ada lagi yang mau disesuaikan? Ketik 'batal' jika sudah selesai.\n\n` + updatedText, msg.messageId);
}

// ============================================================
// MODE 3: TUJUAN TABUNGAN
// ============================================================

async function renderGoalsList(db: SupabaseClient): Promise<string> {
  const goals = await v2GetSavingsGoals(db, ACCESS_CODE);
  const wallets = await v2GetWallets(db, ACCESS_CODE);

  let text = `Daftar Tujuan Tabungan:\n\n`;
  if (goals.length === 0) {
    text += `(kosong)\n`;
  } else {
    goals.forEach((g, idx) => {
      const target = Number(g.target_amount) || 0;
      const linked = wallets.find(w => w.id === g.wallet_id);
      const progress = linked ? Number(linked.balance) : 0;
      const pct = target > 0 ? Math.round((progress / target) * 100) : 0;
      const remaining = target - progress;
      
      text += `${idx + 1}. ${g.name}\n` +
              `   Target     : ${formatRupiah(target)}\n` +
              `   Terkumpul  : ${formatRupiah(progress)} (${pct}%)\n` +
              `   Sisa       : ${formatRupiah(remaining || 0)}\n\n`;
    });
  }

  text += `Mau tambah, edit, atau hapus yang mana?\n` +
    `- Edit: 'edit 1 target 12jt' atau 'edit Laptop target 10jt'\n` +
    `- Tambah: 'tambah Liburan target 5jt'\n` +
    `- Hapus: 'hapus 1' atau 'hapus Laptop'\n\n` +
    `Ketik 'batal' untuk keluar.`;

  return text;
}

export async function handleModeTujuanEnter(
  db: SupabaseClient,
  waChatId: string,
  messageId: string
): Promise<void> {
  const text = await renderGoalsList(db);
  
  await saveV2Session(db, waChatId, ACCESS_CODE, "tujuan", {});
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeTujuanMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Keluar dari mode tujuan tabungan.`, msg.messageId);
    return;
  }

  const goals = await v2GetSavingsGoals(db, ACCESS_CODE);
  const parsedAction = await parseTujuanAction(apiKeys, text, goals);

  if (parsedAction.action === "none") {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Perintah tidak dipahami. Gunakan format 'edit/tambah/hapus' (contoh: 'edit 1 target 15jt', 'tambah Mobil target 120jt').`,
      msg.messageId
    );
    return;
  }

  let targetGoal = null;

  if (parsedAction.index !== null) {
    const idx = parsedAction.index - 1;
    if (idx >= 0 && idx < goals.length) {
      targetGoal = goals[idx];
    }
  } else if (parsedAction.goal_name) {
    const matches = findGoalByName(parsedAction.goal_name, goals);
    if (matches.length === 1) {
      targetGoal = matches[0];
    } else if (matches.length > 1) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Nama tujuan ambigu. Pilihan:\n` + matches.map((g, idx) => `${idx + 1}. ${g.name}`).join("\n") + `\n\nMohon ketik ulang perintah dengan nama tujuan spesifik.`,
        msg.messageId
      );
      return;
    }
  }

  if (parsedAction.action === "delete") {
    if (!targetGoal) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Tujuan tabungan tidak ditemukan.`, msg.messageId);
      return;
    }
    await db.from("savings_goals").delete().eq("id", targetGoal.id);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Tujuan tabungan "${targetGoal.name}" berhasil dihapus.`, msg.messageId);
  } else if (parsedAction.action === "add") {
    if (!parsedAction.goal_name || !(parsedAction.amount > 0)) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Format tambah tujuan tidak lengkap. Sebutkan nama & nominal target.`, msg.messageId);
      return;
    }

    // Buat wallet baru khusus goal ini agar progress bisa dihitung dari wallet balance
    const walletId = `wa_w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("wallets").insert({
      id: walletId,
      access_code: ACCESS_CODE,
      name: `Tabungan ${parsedAction.goal_name}`,
      balance: 0,
      updated_at: new Date().toISOString()
    });

    const goalId = `wa_g_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("savings_goals").insert({
      id: goalId,
      access_code: ACCESS_CODE,
      name: parsedAction.goal_name,
      target_amount: parsedAction.amount,
      wallet_id: walletId,
      updated_at: new Date().toISOString()
    });

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Tujuan tabungan baru "${parsedAction.goal_name}" berhasil dibuat dengan target ${formatRupiah(parsedAction.amount)}.`,
      msg.messageId
    );
  } else if (parsedAction.action === "edit") {
    if (!targetGoal) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Tujuan tabungan tidak ditemukan.`, msg.messageId);
      return;
    }
    const amount = parsedAction.amount ?? 0;
    if (amount <= 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Target nominal tidak valid.`, msg.messageId);
      return;
    }

    await db
      .from("savings_goals")
      .update({
        target_amount: amount,
        updated_at: new Date().toISOString()
      })
      .eq("id", targetGoal.id);

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Tujuan tabungan "${targetGoal.name}" diubah targetnya menjadi ${formatRupiah(amount)}.`,
      msg.messageId
    );
  }

  // Cetak ulang list terupdate
  const updatedText = await renderGoalsList(db);
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Ada lagi yang mau disesuaikan? Ketik 'batal' jika sudah selesai.\n\n` + updatedText, msg.messageId);
}
