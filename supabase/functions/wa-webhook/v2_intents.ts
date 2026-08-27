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
  const prompt = `
Analisis teks pesan masuk dari user WhatsApp berikut dan tentukan intent/maksud aksinya.
Aksi teks bebas yang didukung:
1. "checklist" - Menandai tagihan berulang bulanan sebagai lunas/dibayar (misal: "bayar kuliah", "lunasin cicilan motor").
2. "transfer" - Transfer uang antar dompet/rekening (misal: "transfer dari utama ke tabungan 500rb", "pindahin 100k ke gopay").
3. "debt" - Catat utang baru, piutang baru, cicilan, atau pelunasan utang/piutang ke seseorang (misal: "pinjam ke Budi 100rb", "bayar utang Budi 50rb", "Sari utang ke aku 30k").
4. "query" - Pertanyaan/permintaan informasi mengenai laporan keuangan, detail transaksi, budget, saldo, tagihan, dll (misal: "cek saldo", "berapa pengeluaran makan bulan ini", "apakah ada tagihan jatuh tempo?", "daftar pengeluaran gojek", "selisih bulan lalu").
5. "transaction" - Pencatatan pemasukan, pengeluaran atau transfer biasa dengan menyebutkan nominal secara eksplisit (misal: "makan bakso 15.000", "pemasukan gajian 5.000.000", "bensin 20rb").
6. "general_chat" - Obrolan umum, sapaan, ucapan terima kasih, atau hal di luar keuangan (misal: "halo", "terima kasih ya", "siapa pembuatmu?").

Keluarkan JSON dengan schema berikut:
{
  "intent": "checklist" | "transfer" | "debt" | "query" | "transaction" | "general_chat",
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
    "type": "i_owe" | "owed_to_me" | null,
    // PENTING - Panduan menentukan type:
    // i_owe = SAYA yang berhutang/meminjam DARI orang lain. Uang MASUK ke saya.
    //   Contoh: "pinjem uang ke ayah", "hutang ke Budi 100rb", "pinjam dari Sari", "minjem duit ayah"
    //   Kata kunci: pinjem, pinjam, hutang/utang ke [orang], minjem
    // owed_to_me = ORANG LAIN yang berhutang/meminjam DARI saya. Uang KELUAR dari saya.
    //   Contoh: "Budi hutang ke aku 50rb", "pinjemin Sari 100rb", "kasih pinjaman ke Andi"
    //   Kata kunci: [orang] hutang ke aku/saya, pinjemin/pinjamkan, kasih pinjaman
    // PERINGATAN: "pinjem uang ke ayah" = saya yang meminjam = i_owe (BUKAN owed_to_me!)
    "amount": number | null,
    "is_payment": boolean, // true jika user berniat membayar/melunasi/mencicil utang yang ada (misal ada kata 'bayar', 'lunasi', 'kembalikan', 'lunas'). false jika mencatat utang/piutang baru.
    "note": "string (keterangan tambahan jika ada)"
  }
}

Teks user: "${text}"
`;

  try {
    const responseSchema = {
      type: "OBJECT",
      properties: {
        intent: { type: "STRING", enum: ["checklist", "transfer", "debt", "query", "transaction", "general_chat"] },
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
    return { intent: "transaction" };
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
    id?: string;
    wallet_id: string;
    category_id: string;
    category: string;
    type: "expense" | "income" | "transfer";
    amount: number;
    date: string;
    note: string;
    to_wallet_id?: string | null;
  },
  userId: string,
): Promise<any> {
  const id = tx.id || `wa_tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const { error } = await db.from("transactions").upsert({
    id,
    user_id: userId,
    access_code: "wa_" + userId,
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
  
  await recalculateBalances(db, userId);

  return { id, ...tx };
}

async function recalculateBalances(db: SupabaseClient, userId: string) {
  const { data: wallets } = await db.from("wallets").select("*").eq("user_id", userId);
  const { data: transactions } = await db.from("transactions").select("*").eq("user_id", userId);
  if (!wallets || !transactions) return;

  const { data: settings } = await db
    .from("user_settings")
    .select("nav_config, deleted_ids")
    .eq("user_id", userId)
    .maybeSingle();

  const deletedIds = Array.isArray(settings?.deleted_ids) ? settings.deleted_ids.map(String) : [];
  const deletedSet = new Set(deletedIds);

  const sums: Record<string, number> = {};
  for (const w of wallets) sums[w.id] = 0;

  const todayStr = getTodayStr();

  for (const t of transactions) {
    if (deletedSet.has(String(t.id))) continue; // Skip deleted transactions!
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
  checklistData: any,
  userId: string,
): Promise<boolean> {
  const todayStr = getTodayStr();
  const recurringItems = await v2GetRecurringItems(db, userId);

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
        user_id: userId,
        access_code: "wa_" + userId,
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
  return await executeChecklistPayment(db, apiKeys, waChatId, messageId, selected, userId);
}

export async function executeChecklistPayment(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  replyToMsgId: string,
  checklistDetails: any,
  userId: string,
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
    .eq("user_id", userId)
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

  const { data: walletsCheck } = await db.from("wallets").select("id, is_primary").eq("user_id", userId);
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
  }, userId);

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
  const bubble = `Tagihan dibayar
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
      user_id: userId,
      access_code: "wa_" + userId
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
  transferData: any,
  userId: string,
): Promise<boolean> {
  const amount = Number(transferData.amount) || 0;
  if (amount <= 0) {
    return false;
  }

  const wallets = await v2GetWallets(db, userId);

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

  return await executeTransfer(db, waChatId, messageId, sourceWallet, destWallet, amount, userId);
}

async function executeTransfer(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  sourceWallet: any,
  destWallet: any,
  amount: number,
  userId: string,
): Promise<boolean> {
  const todayStr = getTodayStr();

  const { data: categories } = await db.from("categories").select("*").eq("user_id", userId);
  let cat = categories?.find(c => c.name === "Transfer");
  if (!cat) {
    const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("categories").insert({
      id: catId,
      user_id: userId,
      access_code: "wa_" + userId,
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
  }, userId);

  const { data: updatedWallets } = await db
    .from("wallets")
    .select("id, name, balance")
    .in("id", [sourceWallet.id, destWallet.id]);
  
  const updatedSource = updatedWallets?.find(w => w.id === sourceWallet.id);
  const updatedDest = updatedWallets?.find(w => w.id === destWallet.id);

  const bubble = `Transfer berhasil
Tanggal: ${formatTanggalID(todayStr)}

Nominal: ${formatRupiah(amount)}
Dari dompet: ${sourceWallet.name} (Sisa: ${formatRupiah(updatedSource?.balance ?? 0)})
Ke dompet: ${destWallet.name} (Sisa: ${formatRupiah(updatedDest?.balance ?? 0)})`;

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, replyToMsgId);
  if (sentMsgId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: savedTx.id,
      user_id: userId,
      access_code: "wa_" + userId
    });
  }

  return true;
}

/**
 * 3. Menangani Utang Piutang
 */
function findMentionedWallet(text: string, wallets: any[]): string | undefined {
  const lowerText = text.toLowerCase();
  for (const w of wallets) {
    const lowerName = w.name.toLowerCase();
    if (lowerText.includes(lowerName)) {
      return w.name;
    }
    const words = lowerName.split(/\s+/).filter((word: string) => word.length > 2 && word !== "dompet" && word !== "rekening");
    for (const word of words) {
      if (lowerText.includes(word)) {
        return w.name;
      }
    }
  }
  return undefined;
}

/**
 * 3. Menangani Utang Piutang
 */
export async function handleV2DebtIntent(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  messageId: string,
  userText: string,
  debtData: any,
  userId: string,
): Promise<boolean> {
  if (!debtData.person_name) {
    return false;
  }

  const todayStr = getTodayStr();
  let allDebts = [];
  try {
    allDebts = await v2GetDebtEntries(db, userId);
  } catch (fetchErr) {
    console.error("Error fetching debts:", fetchErr);
    return false;
  }

  const personLower = debtData.person_name.toLowerCase().trim();
  const matchedDebts = (allDebts ?? []).filter(d => (d.person_name || "").toLowerCase().trim() === personLower);
  const activeDebts = matchedDebts.filter(d => d.status === "active" || d.status === "belum");

  let amount = Number(debtData.amount) || 0;

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

    if (amount <= 0) {
      if (activeDebts.length === 1) {
        amount = activeDebts[0].amount;
      } else {
        let optionsText = `Pilih utang/piutang ${debtData.person_name} mana yang mau dilunasi (balas pesan ini dengan angka pilihan):\n\n`;
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
            user_id: userId,
            access_code: "wa_" + userId,
            wa_chat_id: waChatId,
            wa_question_message_id: questionMsgId,
            pending_data: {
              type: "clarify_debt_payment",
              candidates: activeDebts,
              amount: 0,
              user_text: userText
            }
          });
        }
        return true;
      }
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
          user_id: userId,
          access_code: "wa_" + userId,
          wa_chat_id: waChatId,
          wa_question_message_id: questionMsgId,
          pending_data: {
            type: "clarify_debt_payment",
            candidates: activeDebts,
            amount: amount,
            user_text: userText
          }
        });
      }
      return true;
    }

    const activeDebt = activeDebts[0];
    return await executeDebtPayment(db, waChatId, messageId, activeDebt, amount, userText, userId);
  }

  // Untuk membuat utang baru, nominal wajib ada
  if (amount <= 0) {
    return false;
  }

  const debtId = `wa_debt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const type = debtData.type || "i_owe";
  const note = debtData.note || "Catatan WA";

  const { error } = await db.from("debt_entries").insert({
    id: debtId,
    user_id: userId,
    access_code: "wa_" + userId,
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

  // Create Category "Utang Piutang" if not exists
  const { data: categories } = await db.from("categories").select("*").eq("user_id", userId);
  let cat = categories?.find(c => c.name === "Utang Piutang");
  if (!cat) {
    const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("categories").insert({
      id: catId,
      user_id: userId,
      access_code: "wa_" + userId,
      name: "Utang Piutang",
      type: "expense",
      icon: "users",
      color: "#3b82f6"
    });
    cat = { id: catId, name: "Utang Piutang" };
  }

  // Match Wallet from user text
  const { data: walletsList } = await db.from("wallets").select("id, name, is_primary").eq("user_id", userId);
  const mentionedWalletName = findMentionedWallet(userText, walletsList || []);
  const wallets = (walletsList || []) as any[];
  const primaryWallet = wallets.find(w => w.is_primary) || wallets[0];
  const walletId = wallets.find(w => w.name === mentionedWalletName)?.id || primaryWallet?.id || DEFAULT_WALLET_ID;
  const targetWalletName = wallets.find(w => w.id === walletId)?.name || "Dompet Utama";

  // Create Transaction
  const txType = type === "i_owe" ? "income" : "expense";
  const txNote = type === "i_owe" 
    ? `Utang Baru ke ${debtData.person_name}: ${note}`
    : `Piutang Baru ke ${debtData.person_name}: ${note}`;

  const savedTx = await saveV2Transaction(db, {
    id: `tx_debt_${debtId}`,
    wallet_id: walletId,
    category_id: cat.id,
    category: "Utang Piutang",
    type: txType,
    amount: amount,
    date: todayStr,
    note: txNote
  }, userId);

  const typeLabel = type === "i_owe" ? "Kamu berutang ke dia (Saldo Bertambah)" : "Dia berutang ke kamu (Saldo Berkurang)";
  const bubble = `Catatan utang disimpan
Tanggal: ${formatTanggalID(todayStr)}

Nama: ${debtData.person_name}
Jenis: ${typeLabel}
Nominal: ${formatRupiah(amount)}
Dompet: ${targetWalletName}
Keterangan: ${note}`;

  const sentMsgId = await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, bubble, messageId);
  if (sentMsgId) {
    await db.from("wa_message_transactions").insert({
      wa_message_id: sentMsgId,
      transaction_id: debtId,
      user_id: userId,
      access_code: "wa_" + userId
    });
  }

  return true;
}

export async function executeDebtPayment(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  activeDebt: any,
  paymentAmount: number,
  userText?: string,
  userId?: string,
): Promise<boolean> {
  const todayStr = getTodayStr();

  const { data: categories } = await db.from("categories").select("*").eq("user_id", userId);
  let cat = categories?.find(c => c.name === "Utang Piutang");
  if (!cat) {
    const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("categories").insert({
      id: catId,
      user_id: userId,
      access_code: "wa_" + userId,
      name: "Utang Piutang",
      type: "expense",
      icon: "users",
      color: "#3b82f6"
    });
    cat = { id: catId, name: "Utang Piutang" };
  }

  const isIOwe = activeDebt.type === "i_owe" || activeDebt.type === "utang";
  const txType = isIOwe ? "expense" : "income";
  const { data: walletsDebt } = await db.from("wallets").select("id, name, is_primary").eq("user_id", userId);
  const mentionedWalletName = userText ? findMentionedWallet(userText, walletsDebt || []) : undefined;
  const primaryWalletDebt = walletsDebt?.find(w => w.is_primary) || walletsDebt?.[0];
  const walletId = walletsDebt?.find(w => w.name === mentionedWalletName)?.id || primaryWalletDebt?.id || DEFAULT_WALLET_ID;
  const targetWalletName = walletsDebt?.find(w => w.id === walletId)?.name || "Dompet Utama";

  const payoffAmount = paymentAmount <= 0 ? activeDebt.amount : paymentAmount;

  let bubble = "";
  let savedTxId = "";

  if (payoffAmount < activeDebt.amount) {
    const remaining = activeDebt.amount - payoffAmount;
    
    const tx = await saveV2Transaction(db, {
      wallet_id: walletId,
      category_id: cat.id,
      category: "Utang Piutang",
      type: txType,
      amount: payoffAmount,
      date: todayStr,
      note: `Cicilan utang ke ${activeDebt.person_name}: ${activeDebt.note || ""}`.trim()
    }, userId);
    savedTxId = tx.id;

    await db
      .from("debt_entries")
      .update({
        amount: remaining,
        updated_at: new Date().toISOString()
      })
      .eq("id", activeDebt.id);

    bubble = `Cicilan utang dicatat
Tanggal: ${formatTanggalID(todayStr)}

Pembayaran: ${formatRupiah(payoffAmount)} (Saldo ${txType === "expense" ? "Berkurang" : "Bertambah"})
Dompet: ${targetWalletName}
Untuk: ${isIOwe ? "Utang ke" : "Piutang dari"} ${activeDebt.person_name}
Sisa utang: ${formatRupiah(remaining)}

Keterangan: ${activeDebt.note || "-"}`;

  } else {
    const excess = payoffAmount - activeDebt.amount;
    
    const tx = await saveV2Transaction(db, {
      wallet_id: walletId,
      category_id: cat.id,
      category: "Utang Piutang",
      type: txType,
      amount: activeDebt.amount,
      date: todayStr,
      note: `Pelunasan utang ke ${activeDebt.person_name}: ${activeDebt.note || ""}`.trim()
    }, userId);
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

    bubble = `Utang lunas
Tanggal: ${formatTanggalID(todayStr)}

Pembayaran: ${formatRupiah(activeDebt.amount)} (Saldo ${txType === "expense" ? "Berkurang" : "Bertambah"})
Dompet: ${targetWalletName}
Keterangan: ${activeDebt.note || "-"}\n`;

    if (excess > 0) {
      const reverseType = isIOwe ? "owed_to_me" : "i_owe";
      const newDebtId = `wa_debt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("debt_entries").insert({
        id: newDebtId,
        user_id: userId,
        access_code: "wa_" + userId,
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
      user_id: userId,
      access_code: "wa_" + userId
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
  pendingData: any,
  userId: string,
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
    await executeChecklistPayment(db, apiKeys, waChatId, msg.messageId, selected, userId);
  } else if (pendingData.type === "clarify_debt_payment") {
    await executeDebtPayment(db, waChatId, msg.messageId, selected, pendingData.amount, pendingData.user_text, userId);
  }

  return true;
}
