// supabase/functions/wa-webhook/v2_intents.ts
// VERSI 2 - Logika Intent Teks Bebas: Checklist, Transfer, Utang-Piutang (Revisi Sesi & Balasan)

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callGeminiRaw, extractGeminiText, getTodayStr, formatRupiah, formatTanggalID } from "./gemini.ts";
import { sendWhatsAppMessage } from "./whatsapp.ts";
import {
  v2GetWallets,
  v2GetCategories,
  v2GetRecurringItems,
  v2GetDebtEntries
} from "./v2_db.ts";
import { getRecurringStatus } from "./v2_query.ts";

const PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;
const ACCESS_CODE = Deno.env.get("WA_ACCESS_CODE") ?? "";
const DEFAULT_WALLET_ID = Deno.env.get("WA_DEFAULT_WALLET_ID") ?? "wallet_utama";

// ============================================================
// GEMINI PARSERS
// ============================================================

export async function parseV2Intent(
  apiKeys: string[],
  text: string
): Promise<any> {
  const cleaned = text.toLowerCase();
  
  // Quick local check to bypass Gemini intent parsing for obvious normal transactions
  const intentKeywords = [
    "transfer", "pindah", "pindahin", "tf", "mutasi",
    "pinjam", "pinjem", "utang", "hutang", "piutang", "talang", "talangin", "kembalikan", "balikin",
    "lunas", "lunasin", "cicilan", "tagihan", "arisan"
  ];
  
  const hasKeyword = intentKeywords.some(kw => cleaned.includes(kw));
  if (!hasKeyword) {
    return { intent: "none" };
  }

  const prompt = `
Analisis teks pesan masuk dari user WhatsApp berikut dan tentukan intent/maksud aksinya.
Aksi teks bebas yang didukung:
1. "checklist" - Menandai tagihan berulang/checklist bulanan sebagai lunas/dibayar (misal: "bayar kuliah", "lunasin cicilan motor").
2. "transfer" - Transfer uang antar dompet/rekening (misal: "transfer dari utama ke tabungan 500rb", "pindahin 100k ke gopay").
3. "debt" - Catat utang baru, piutang baru, cicilan, atau pelunasan utang/piutang ke seseorang (misal: "pinjam ke Budi 100rb", "bayar utang Budi 50rb", "Sari utang ke aku 30k").
4. "none" - Bukan salah satu dari di atas (misal transaksi pengeluaran biasa seperti "beli bakso 15rb", atau pertanyaan umum).

Keluarkan JSON dengan schema berikut:
{
  "intent": "checklist" | "transfer" | "debt" | "none",
  "checklist": {
    "item_name": "string (nama tagihan/item checklist yang dicari, misal 'kuliah' atau 'cicilan motor')",
    "amount": number | null
  },
  "transfer": {
    "source_wallet": "string (dompet asal, misal 'utama')",
    "dest_wallet": "string (dompet tujuan, misal 'tabungan')",
    "amount": number | null
  },
  "debt": {
    "person_name": "string (nama orang, misal 'Budi' atau 'Sari')",
    "type": "i_owe" | "owed_to_me" | null, // i_owe jika saya meminjam/berhutang ke dia. owed_to_me jika dia meminjam/berhutang ke saya.
    "amount": number | null,
    "is_payment": boolean, // true jika user berniat membayar/melunasi/mencicil utang yang ada (misal ada kata 'bayar', 'lunasi', 'kembalikan'). false jika mencatat utang/piutang baru.
    "note": "string (keterangan tambahan jika ada)"
  }
}

Teks user: "${text}"
`;

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        intent: { type: "STRING", enum: ["checklist", "transfer", "debt", "none"] },
        checklist: {
          type: "OBJECT",
          properties: {
            item_name: { type: "STRING" },
            amount: { type: "NUMBER" }
          },
          required: ["item_name"]
        },
        transfer: {
          type: "OBJECT",
          properties: {
            source_wallet: { type: "STRING" },
            dest_wallet: { type: "STRING" },
            amount: { type: "NUMBER" }
          },
          required: ["source_wallet", "dest_wallet", "amount"]
        },
        debt: {
          type: "OBJECT",
          properties: {
            person_name: { type: "STRING" },
            type: { type: "STRING", enum: ["i_owe", "owed_to_me"] },
            amount: { type: "NUMBER" },
            is_payment: { type: "BOOLEAN" },
            note: { type: "STRING" }
          },
          required: ["person_name", "is_payment"]
        }
      },
      required: ["intent"]
    };

    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    return JSON.parse(resultText);
  } catch (err) {
    console.error("Error in parseV2Intent:", err);
    return { intent: "none" };
  }
}

async function matchChecklistSemanticWithAi(
  apiKeys: string[],
  userText: string,
  items: Array<{ id: string; name: string; amount: number; next_due_date: string }>
): Promise<string[]> {
  const prompt = `
Cocokkan kalimat user berikut terhadap daftar item tagihan/checklist jatuh tempo yang tersedia.
User ingin membayar/menyelesaikan salah satu tagihan. Pilihlah item tagihan yang secara semantik/makna cocok dengan kalimat user (abaikan kata kerja seperti "bayar", "lunas", "beres").

Daftar tagihan jatuh tempo:
${items.map((it, idx) => `${idx + 1}. ID: "${it.id}", Nama: "${it.name}", Nominal: ${it.amount}`).join("\n")}

Kalimat user: "${userText}"

Aturan:
- Kembalikan array berisi ID tagihan yang cocok.
- Jika ada kecocokan yang ambigu (misal user sebut "cicilan" dan ada "Cicilan Mobil" serta "Cicilan Motor"), kembalikan semua ID yang berpotensi cocok.
- Jika tidak ada yang cocok sama sekali, kembalikan array kosong [].

Keluarkan JSON dengan schema:
{
  "matches": ["string (ID yang cocok)"]
}
`;

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        matches: {
          type: "ARRAY",
          items: { type: "STRING" }
        }
      },
      required: ["matches"]
    };

    const data = await callGeminiRaw(apiKeys, [{ text: prompt }], 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    const parsed = JSON.parse(resultText);
    return parsed.matches || [];
  } catch (err) {
    console.error("Error in matchChecklistSemanticWithAi:", err);
    return [];
  }
}

// ============================================================
// LOGIKA EKSKUSI INTENT
// ============================================================

async function saveV2Transaction(
  db: SupabaseClient,
  tx: {
    wallet_id: string;
    category_id: string;
    category: string;
    type: "expense" | "income" | "transfer";
    amount: number;
    date: string;
    note: string;
    to_wallet_id?: string | null;
  }
): Promise<any> {
  const id = `wa_tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const { error } = await db.from("transactions").insert({
    id,
    access_code: ACCESS_CODE,
    wallet_id: tx.wallet_id,
    category_id: tx.category_id,
    category: tx.category,
    type: tx.type,
    amount: tx.amount,
    date: tx.date,
    note: tx.note,
    to_wallet_id: tx.to_wallet_id || null,
    source: "whatsapp",
    updated_at: new Date().toISOString()
  });

  if (error) throw new Error(`Gagal menyimpan transaksi V2: ${error.message}`);
  
  await recalculateBalances(db);

  return { id, ...tx };
}

async function recalculateBalances(db: SupabaseClient) {
  const { data: wallets } = await db.from("wallets").select("*").eq("access_code", ACCESS_CODE);
  const { data: transactions } = await db.from("transactions").select("*").eq("access_code", ACCESS_CODE);
  if (!wallets || !transactions) return;

  const sums: Record<string, number> = {};
  for (const w of wallets) sums[w.id] = 0;

  const todayStr = getTodayStr();

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

  const { data: settings } = await db
    .from("user_settings")
    .select("nav_config")
    .eq("access_code", ACCESS_CODE)
    .maybeSingle();

  const navConfig = settings?.nav_config || {};
  const initialBalances = navConfig.initialBalances || {};

  for (const w of wallets) {
    if (initialBalances[w.id] === undefined) {
      initialBalances[w.id] = (Number(w.balance) || 0) - (sums[w.id] || 0);
    }
    const newBalance = (Number(initialBalances[w.id]) || 0) + (sums[w.id] || 0);
    if (w.balance !== newBalance) {
      await db
        .from("wallets")
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq("id", w.id);
    }
  }
}

/**
 * 1. Menangani Checklist Lunas
 */
export async function handleV2ChecklistIntent(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  messageId: string,
  userText: string,
  checklistData: any
): Promise<boolean> {
  const todayStr = getTodayStr();
  const recurringItems = await v2GetRecurringItems(db, ACCESS_CODE);

  const dueItems = recurringItems
    .map(item => {
      const { status, nextDue } = getRecurringStatus(item, todayStr, 25);
      return { item, status, nextDue };
    })
    .filter(x => x.status === "terlambat" || x.status === "jatuh-tempo")
    .map(x => ({
      id: x.item.id,
      name: x.item.name,
      amount: Number(x.item.amount) || 0,
      category_id: x.item.category_id,
      wallet_id: x.item.wallet_id,
      type: x.item.type,
      next_due_date: x.nextDue
    }));

  if (!dueItems.length) {
    return false;
  }

  const matches = await matchChecklistSemanticWithAi(apiKeys, userText, dueItems);

  if (matches.length === 0) {
    return false;
  }

  if (matches.length > 1) {
    const candidates = dueItems.filter(d => matches.includes(d.id));
    let optionsText = `Ada lebih dari satu tagihan jatuh tempo yang cocok. Balas pesan ini dengan mengetik nomor pilihan:\n\n`;
    candidates.forEach((c, idx) => {
      optionsText += `${idx + 1}. ${c.name} (${formatRupiah(c.amount)})\n`;
    });

    const questionMsgId = await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      optionsText,
      messageId
    );

    if (questionMsgId) {
      await db.from("wa_pending_transactions").insert({
        id: `pend_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        access_code: ACCESS_CODE,
        wa_chat_id: waChatId,
        wa_question_message_id: questionMsgId,
        pending_data: {
          type: "clarify_checklist",
          candidates: candidates
        }
      });
    }
    return true;
  }

  const selected = dueItems.find(d => d.id === matches[0])!;
  return await executeChecklistPayment(db, apiKeys, waChatId, messageId, selected);
}

export async function executeChecklistPayment(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  replyToMsgId: string,
  checklistDetails: any
): Promise<boolean> {
  const todayStr = getTodayStr();

  const { data: catData } = await db
    .from("categories")
    .select("name")
    .eq("id", checklistDetails.category_id)
    .maybeSingle();
  const categoryName = catData?.name ?? "Lainnya";

  let amount = checklistDetails.amount;
  
  const { data: txs } = await db
    .from("transactions")
    .select("amount")
    .eq("access_code", ACCESS_CODE)
    .eq("type", checklistDetails.type)
    .eq("category_id", checklistDetails.category_id)
    .eq("note", checklistDetails.name)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(1);

  if (txs && txs.length > 0) {
    amount = Number(txs[0].amount) || amount;
  }

  if (!(amount > 0)) {
    return false;
  }

  const { data: walletsCheck } = await db.from("wallets").select("id, is_primary").eq("access_code", ACCESS_CODE);
  const primaryWalletCheck = walletsCheck?.find(w => w.is_primary) || walletsCheck?.[0];
  const walletId = checklistDetails.wallet_id || primaryWalletCheck?.id || DEFAULT_WALLET_ID;
  const savedTx = await saveV2Transaction(db, {
    wallet_id: walletId,
    category_id: checklistDetails.category_id,
    category: categoryName,
    type: checklistDetails.type as "expense" | "income",
    amount,
    date: todayStr,
    note: checklistDetails.name
  });

  await db
    .from("recurring_items")
    .update({
      last_confirmed_date: todayStr,
      updated_at: new Date().toISOString()
    })
    .eq("id", checklistDetails.id);

  const { data: walletData } = await db.from("wallets").select("name, balance").eq("id", walletId).single();
  const walletName = walletData?.name ?? "Dompet";
  const walletBalance = Number(walletData?.balance) || 0;

  const typeLabel = checklistDetails.type === "income" ? "Pemasukan" : "Pengeluaran";
  const bubble = `Tagihan dibayar ✓
Tanggal: ${formatTanggalID(todayStr)}

${typeLabel}: ${formatRupiah(amount)}
Kategori: ${categoryName}
Keterangan: ${checklistDetails.name}

Dompet: ${walletName}
Sisa dompet: ${formatRupiah(walletBalance)}`;

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, replyToMsgId);
  if (sentMsgId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: savedTx.id,
      access_code: ACCESS_CODE
    });
  }

  return true;
}

/**
 * 2. Menangani Wallet Transfer
 */
export async function handleV2TransferIntent(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  messageId: string,
  transferData: any
): Promise<boolean> {
  const amount = Number(transferData.amount) || 0;
  if (amount <= 0) {
    return false;
  }

  const wallets = await v2GetWallets(db, ACCESS_CODE);

  const sourceMatches = wallets.filter(w =>
    w.name.toLowerCase().includes(transferData.source_wallet.toLowerCase())
  );
  const destMatches = wallets.filter(w =>
    w.name.toLowerCase().includes(transferData.dest_wallet.toLowerCase())
  );

  if (sourceMatches.length === 0 || destMatches.length === 0 || sourceMatches.length > 1 || destMatches.length > 1) {
    let questionText = "";
    if (sourceMatches.length === 0) {
      questionText = `Dompet asal "${transferData.source_wallet}" tidak ditemukan.`;
    } else if (destMatches.length === 0) {
      questionText = `Dompet tujuan "${transferData.dest_wallet}" tidak ditemukan.`;
    } else if (sourceMatches.length > 1) {
      questionText = `Dompet asal "${transferData.source_wallet}" ambigu. Pilihan:\n` + sourceMatches.map((w, i) => `${i+1}. ${w.name}`).join("\n");
    } else {
      questionText = `Dompet tujuan "${transferData.dest_wallet}" ambigu. Pilihan:\n` + destMatches.map((w, i) => `${i+1}. ${w.name}`).join("\n");
    }

    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `${questionText}\n\nMohon tulis kembali perintah transfer dengan nama dompet yang jelas.`, messageId);
    return true;
  }

  const sourceWallet = sourceMatches[0];
  const destWallet = destMatches[0];

  if (sourceWallet.id === destWallet.id) {
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Gagal: Dompet asal dan tujuan tidak boleh sama.`, messageId);
    return true;
  }

  return await executeTransfer(db, waChatId, messageId, sourceWallet, destWallet, amount);
}

async function executeTransfer(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  sourceWallet: any,
  destWallet: any,
  amount: number
): Promise<boolean> {
  const todayStr = getTodayStr();

  const { data: categories } = await db.from("categories").select("*").eq("access_code", ACCESS_CODE);
  let cat = categories?.find(c => c.name === "Transfer");
  if (!cat) {
    const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("categories").insert({
      id: catId,
      access_code: ACCESS_CODE,
      name: "Transfer",
      type: "expense",
      icon: "refresh",
      color: "#6b7280"
    });
    cat = { id: catId, name: "Transfer" };
  }

  const savedTx = await saveV2Transaction(db, {
    wallet_id: sourceWallet.id,
    category_id: cat.id,
    category: "Transfer",
    type: "transfer",
    amount,
    date: todayStr,
    note: `Transfer ke ${destWallet.name}`,
    to_wallet_id: destWallet.id
  });

  const { data: updatedWallets } = await db
    .from("wallets")
    .select("id, name, balance")
    .in("id", [sourceWallet.id, destWallet.id]);
  
  const updatedSource = updatedWallets?.find(w => w.id === sourceWallet.id);
  const updatedDest = updatedWallets?.find(w => w.id === destWallet.id);

  const bubble = `Transfer berhasil ✓
Tanggal: ${formatTanggalID(todayStr)}

Nominal: ${formatRupiah(amount)}
Dari dompet: ${sourceWallet.name} (Sisa: ${formatRupiah(updatedSource?.balance ?? 0)})
Ke dompet: ${destWallet.name} (Sisa: ${formatRupiah(updatedDest?.balance ?? 0)})`;

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, replyToMsgId);
  if (sentMsgId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: savedTx.id,
      access_code: ACCESS_CODE
    });
  }

  return true;
}

/**
 * 3. Menangani Utang Piutang
 */
export async function handleV2DebtIntent(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  messageId: string,
  debtData: any
): Promise<boolean> {
  const amount = Number(debtData.amount) || 0;
  if (amount <= 0 || !debtData.person_name) {
    return false;
  }

  const todayStr = getTodayStr();
  const allDebts = await db
    .from("debt_entries")
    .select("*")
    .eq("access_code", ACCESS_CODE)
    .eq("person_name", debtData.person_name);

  const activeDebts = allDebts.filter(d => d.status === "active" || d.status === "belum");

  if (debtData.is_payment) {
    if (activeDebts.length === 0) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Tidak ada catatan utang/piutang aktif atas nama ${debtData.person_name}.`,
        messageId
      );
      return true;
    }

    if (activeDebts.length > 1) {
      let optionsText = `Pilih utang/piutang ${debtData.person_name} mana yang mau dibayar (balas pesan ini dengan angka pilihan):\n\n`;
      activeDebts.forEach((d, idx) => {
        const typeLabel = d.type === "i_owe" || d.type === "utang" ? "Kamu berutang" : "Dia berutang";
        optionsText += `${idx + 1}. ${typeLabel}: ${formatRupiah(d.amount)} (${d.note || "Tanpa keterangan"})\n`;
      });

      const questionMsgId = await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        optionsText,
        messageId
      );

      if (questionMsgId) {
        await db.from("wa_pending_transactions").insert({
          id: `pend_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
          access_code: ACCESS_CODE,
          wa_chat_id: waChatId,
          wa_question_message_id: questionMsgId,
          pending_data: {
            type: "clarify_debt_payment",
            candidates: activeDebts,
            amount: amount
          }
        });
      }
      return true;
    }

    const activeDebt = activeDebts[0];
    return await executeDebtPayment(db, waChatId, messageId, activeDebt, amount);
  }

  const debtId = `wa_debt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const type = debtData.type || "i_owe";
  const note = debtData.note || "Catatan WA";

  const { error } = await db.from("debt_entries").insert({
    id: debtId,
    access_code: ACCESS_CODE,
    person_name: debtData.person_name,
    type,
    amount,
    date: todayStr,
    note,
    status: "active",
    updated_at: new Date().toISOString()
  });

  if (error) {
    console.error("Error creating debt:", error);
    return false;
  }

  const typeLabel = type === "i_owe" ? "Kamu berutang ke dia" : "Dia berutang ke kamu";
  const bubble = `Catatan utang disimpan ✓
Tanggal: ${formatTanggalID(todayStr)}

Nama: ${debtData.person_name}
Jenis: ${typeLabel}
Nominal: ${formatRupiah(amount)}
Keterangan: ${note}`;

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, messageId);
  if (sentMsgId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: debtId,
      access_code: ACCESS_CODE
    });
  }

  return true;
}

export async function executeDebtPayment(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  activeDebt: any,
  paymentAmount: number
): Promise<boolean> {
  const todayStr = getTodayStr();

  const { data: categories } = await db.from("categories").select("*").eq("access_code", ACCESS_CODE);
  let cat = categories?.find(c => c.name === "Utang Piutang");
  if (!cat) {
    const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("categories").insert({
      id: catId,
      access_code: ACCESS_CODE,
      name: "Utang Piutang",
      type: "expense",
      icon: "users",
      color: "#3b82f6"
    });
    cat = { id: catId, name: "Utang Piutang" };
  }

  const isIOwe = activeDebt.type === "i_owe" || activeDebt.type === "utang";
  const txType = isIOwe ? "expense" : "income";
  const { data: walletsDebt } = await db.from("wallets").select("id, is_primary").eq("access_code", ACCESS_CODE);
  const primaryWalletDebt = walletsDebt?.find(w => w.is_primary) || walletsDebt?.[0];
  const walletId = primaryWalletDebt?.id || DEFAULT_WALLET_ID;

  let bubble = "";
  let savedTxId = "";

  if (paymentAmount < activeDebt.amount) {
    const remaining = activeDebt.amount - paymentAmount;
    
    const tx = await saveV2Transaction(db, {
      wallet_id: walletId,
      category_id: cat.id,
      category: "Utang Piutang",
      type: txType,
      amount: paymentAmount,
      date: todayStr,
      note: `Cicilan utang Budi: ${activeDebt.note || ""}`.trim()
    });
    savedTxId = tx.id;

    await db
      .from("debt_entries")
      .update({
        amount: remaining,
        updated_at: new Date().toISOString()
      })
      .eq("id", activeDebt.id);

    bubble = `Cicilan utang dicatat ✓
Tanggal: ${formatTanggalID(todayStr)}

Pembayaran: ${formatRupiah(paymentAmount)}
Untuk: ${isIOwe ? "Utang ke" : "Piutang dari"} ${activeDebt.person_name}
Sisa sisa utang: ${formatRupiah(remaining)}

Keterangan: ${activeDebt.note || "-"}`;

  } else {
    const excess = paymentAmount - activeDebt.amount;
    
    const tx = await saveV2Transaction(db, {
      wallet_id: walletId,
      category_id: cat.id,
      category: "Utang Piutang",
      type: txType,
      amount: paymentAmount,
      date: todayStr,
      note: `Pelunasan utang Budi: ${activeDebt.note || ""}`.trim()
    });
    savedTxId = tx.id;

    await db
      .from("debt_entries")
      .update({
        status: "lunas",
        payoff_wallet_id: walletId,
        payoff_date: todayStr,
        updated_at: new Date().toISOString()
      })
      .eq("id", activeDebt.id);

    bubble = `Utang lunas ✓
Tanggal: ${formatTanggalID(todayStr)}

Pembayaran: ${formatRupiah(paymentAmount)}
Keterangan: ${activeDebt.note || "-"}\n`;

    if (excess > 0) {
      const reverseType = isIOwe ? "owed_to_me" : "i_owe";
      const newDebtId = `wa_debt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("debt_entries").insert({
        id: newDebtId,
        access_code: ACCESS_CODE,
        person_name: activeDebt.person_name,
        type: reverseType,
        amount: excess,
        date: todayStr,
        note: `Kelebihan pembayaran untuk utang: ${activeDebt.note || ""}`.trim(),
        status: "active",
        updated_at: new Date().toISOString()
      });

      const reverseLabel = reverseType === "i_owe" ? "Kamu berutang ke dia" : "Dia berutang ke kamu";
      bubble += `\nKelebihan bayar: ${formatRupiah(excess)} (Kini dicatat sebagai utang baru: ${reverseLabel})`;
    }
  }

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, replyToMsgId);
  if (sentMsgId && savedTxId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: savedTxId,
      access_code: ACCESS_CODE
    });
  }

  return true;
}

// ============================================================
// CLARIFICATION RESPONSES
// ============================================================

export async function handleV2ClarificationReply(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  pendingData: any
): Promise<boolean> {
  const waChatId = msg.from;
  const replyText = (msg.text ?? "").trim();
  const choiceIdx = parseInt(replyText, 10) - 1;

  if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= pendingData.candidates.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Pilihan tidak valid. Silakan balas dengan angka pilihan yang sesuai (1, 2, dst).`,
      msg.messageId
    );
    return true;
  }

  const selected = pendingData.candidates[choiceIdx];

  if (pendingData.type === "clarify_checklist") {
    await executeChecklistPayment(db, apiKeys, waChatId, msg.messageId, selected);
  } else if (pendingData.type === "clarify_debt_payment") {
    await executeDebtPayment(db, waChatId, msg.messageId, selected, pendingData.amount);
  }

  return true;
}
