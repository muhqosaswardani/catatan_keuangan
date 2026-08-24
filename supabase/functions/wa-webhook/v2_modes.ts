// supabase/functions/wa-webhook/v2_modes.ts
// VERSI 2 - Logika Mode Terkunci: Koreksi, Limit, Tujuan (Revisi Concurrency & Batching)

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callGeminiRaw, extractGeminiText, getTodayStr, formatRupiah, formatTanggalID } from "./gemini.ts";
import { sendWhatsAppMessage, downloadWhatsAppMedia, safeBytesToBase64 } from "./whatsapp.ts";
import {
  v2GetWallets,
  v2GetCategories,
  v2GetBudgets,
  v2GetSavingsGoals,
  saveV2Session,
  clearV2Session,
  logToDb,
  getV2Session
} from "./v2_db.ts";

declare const EdgeRuntime: any;

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

// Helper sorting kategori & goal
function sortExpenseCategories(expenseCats: any[], budgets: any[]): any[] {
  return [...expenseCats].sort((catA, catB) => {
    const bA = budgets.find(b => b.category_id === catA.id);
    const bB = budgets.find(b => b.category_id === catB.id);
    const hasLimitA = bA ? 1 : 0;
    const hasLimitB = bB ? 1 : 0;
    if (hasLimitA !== hasLimitB) {
      return hasLimitB - hasLimitA; // Kategori berlimit di atas
    }
    return catA.name.localeCompare(catB.name); // Alfabetis jika sama
  });
}

function sortGoals(goals: any[]): any[] {
  return [...goals].sort((goalA, goalB) => {
    const targetA = Number(goalA.target_amount) || 0;
    const targetB = Number(goalB.target_amount) || 0;
    const hasTargetA = targetA > 0 ? 1 : 0;
    const hasTargetB = targetB > 0 ? 1 : 0;
    if (hasTargetA !== hasTargetB) {
      return hasTargetB - hasTargetA; // Ber-target di atas
    }
    return goalA.name.localeCompare(goalB.name);
  });
}

// ============================================================
// GEMINI ACTION PARSERS
// ============================================================

async function parseKoreksiAction(
  apiKeys: string[],
  text: string,
  mediaParts: any[],
  selectedWallets: any[],
  draftItems: any[]
): Promise<any[]> {
  const prompt = `
Kamu asisten Mode Koreksi Saldo. User sedang mengoreksi saldo dompet terpilih berikut:
${selectedWallets.map((w, idx) => `${idx + 1}. ${w.name} (ID: ${w.id})${w.is_primary ? " (Primary)" : ""}`).join("\n")}

Draft koreksi saat ini:
${draftItems.map((it, idx) => {
  const breakdownStr = it.breakdown ? it.breakdown.map(b => `${b.name}: ${b.amount}`).join(", ") : "";
  return `${idx + 1}. Wallet: ${it.wallet_name}, Actual: ${it.amount} (${breakdownStr})`;
}).join("\n")}

Tugasmu:
1. Baca semua gambar screenshot/foto saldo rekening bank, e-wallet (DANA, OVO, GoPay, ShopeePay, LinkAja, dll), atau kalimat user.
2. Ekstrak nama akun/sumber saldo (misal: "DANA", "OVO", "GoPay", "ShopeePay", "Livin' by Mandiri", "BCA", "Uang Cash") dan nominal saldonya yang terbaca dari gambar/teks.
3. Cocokkan nama akun tersebut ke salah satu dompet terpilih di atas. Secara umum:
   - Akun e-wallet (GoPay, OVO, DANA, ShopeePay) dan rekening bank operasional harian (seperti Livin' by Mandiri, BCA) atau Uang Cash dicocokkan ke dompet terpilih yang ditandai (Primary) di atas.
   - Bila user merujuk nomor indeks dompet (misal: "1 50rb"), cocokkan ke dompet terpilih ke-1.
   - Bila ragu atau tidak cocok spesifik ke dompet lain, cocokkan ke dompet terpilih yang ditandai (Primary).
4. Keluarkan daftar item yang terdeteksi.

Keluarkan JSON dengan schema:
{
  "detected_items": [
    {
      "account_name": "string (nama akun yang terbaca, misal: 'DANA', 'GoPay', 'Input Manual')",
      "amount": number,
      "target_wallet_id": "string (ID dompet terpilih tempat akun ini dicocokkan)"
    }
  ]
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
        detected_items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              account_name: { type: "STRING" },
              amount: { type: "NUMBER" },
              target_wallet_id: { type: "STRING" }
            },
            required: ["account_name", "amount", "target_wallet_id"]
          }
        }
      },
      required: ["detected_items"]
    };

    const data = await callGeminiRaw(apiKeys, parts, 0.1, responseSchema);
    const resultText = extractGeminiText(data);
    const parsed = JSON.parse(resultText);
    return parsed.detected_items || [];
  } catch (err) {
    console.error("Error in parseKoreksiAction:", err);
    return [];
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
${goals.map((g, idx) => `${idx + 1}. Tujuan: ${g.name}, Target: ${g.target_amount}`).join("\n")}

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
  messageId: string,
  userId: string
): Promise<void> {
  const wallets = await v2GetWallets(db, userId);
  let text = `*Mode Koreksi Saldo* (Cek)
Pilih dompet yang mau dikoreksi (boleh lebih dari satu):

${wallets.map((w, idx) => `${idx + 1}. ${w.name} — ${formatRupiah(w.balance)}`).join("\n")}

Ketik nomornya, mis. "1" untuk satu dompet, "1 2" untuk beberapa dompet sekaligus, atau ketik "semua" untuk semua dompet.
Ketik 'batal' untuk keluar dari mode.`;

  await saveV2Session(db, waChatId, userId, "koreksi", {
    step: 1,
    selected_wallets: [],
    items: [],
    pending_batch_inputs: []
  });
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeKoreksiMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any,
  userId: string
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  await logToDb(db, "handleModeKoreksiMessage Triggered", { cleaned, sessionData: session.session_data });

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Mode koreksi dibatalkan. Tidak ada perubahan saldo.`, msg.messageId);
    return;
  }

  const wallets = await v2GetWallets(db, userId);

  // Alur Langkah 1: Pemilihan Dompet
  if (session.session_data.step === 1 || !session.session_data.step) {
    const tokens = cleaned.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
    const selectedIds: string[] = [];

    tokens.forEach(tok => {
      if (tok.toLowerCase() === "semua") {
        wallets.forEach(w => selectedIds.push(w.id));
        return;
      }
      const num = parseInt(tok, 10);
      if (!isNaN(num) && num > 0 && num <= wallets.length) {
        selectedIds.push(wallets[num - 1].id);
      } else {
        const found = wallets.find(w => w.name.toLowerCase().includes(tok.toLowerCase()));
        if (found) selectedIds.push(found.id);
      }
    });

    if (selectedIds.length === 0) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Pilihan dompet tidak valid. Silakan balas dengan mengetik nomor dompet (misal: '1' atau '1 2'), atau ketik nama dompetnya.`,
        msg.messageId
      );
      return;
    }

    const selectedWallets = wallets.filter(w => selectedIds.includes(w.id));
    const items = selectedWallets.map(w => ({
      wallet_id: w.id,
      wallet_name: w.name,
      amount: Number(w.balance) || 0,
      breakdown: []
    }));

    await saveV2Session(db, waChatId, userId, "koreksi", {
      step: 2,
      selected_wallets: selectedIds,
      items,
      pending_batch_inputs: []
    });

    let reply = `Dompet terpilih untuk dikoreksi:\n`;
    selectedWallets.forEach((w, idx) => {
      reply += `${idx + 1}. ${w.name} (Saldo saat ini: ${formatRupiah(w.balance)})\n`;
    });
    reply += `\nSilakan kirim foto uang fisik (struk) atau ketik nilai nominal aktual untuk dompet-dompet di atas (contoh: 'dompet utama 50rb', '1 50rb', atau jika hanya 1 dompet langsung ketik angkanya '50000').\n\n` +
             `Ketik *"ya"* jika semua nominal sudah sesuai untuk memproses, atau *"batal"* untuk keluar.`;

    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, reply, msg.messageId);
    return;
  }

  // Alur Langkah 2: Memproses Foto / Input Nominal (Dengan Batching)
  const draftItems = session.session_data.items || [];

  if (cleaned === "ya" || cleaned === "oke") {
    if (draftItems.length === 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Draft koreksi kosong. Silakan kirim data koreksi dulu atau ketik 'batal' untuk keluar.`, msg.messageId);
      return;
    }

    // Eksekusi koreksi saldo (Penyesuaian Saldo)
    const { data: categories } = await db.from("categories").select("*").eq("user_id", userId);
    let catExpense = categories?.find(c => c.name === "Penyesuaian Saldo" && c.type === "expense");
    let catIncome = categories?.find(c => c.name === "Penyesuaian Saldo" && c.type === "income");

    if (!catExpense) {
      const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("categories").insert({ id: catId, user_id: userId, access_code: "wa_" + userId, name: "Penyesuaian Saldo", type: "expense", icon: "sliders", color: "#6b7280" });
      catExpense = { id: catId, name: "Penyesuaian Saldo" };
    }
    if (!catIncome) {
      const catId = `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.from("categories").insert({ id: catId, user_id: userId, access_code: "wa_" + userId, name: "Penyesuaian Saldo", type: "income", icon: "sliders", color: "#6b7280" });
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
        user_id: userId,
        access_code: "wa_" + userId,
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
    const { data: rawWallets } = await db.from("wallets").select("*").eq("user_id", userId);
    const { data: transactions } = await db.from("transactions").select("*").eq("user_id", userId);
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

      const { data: settings } = await db.from("user_settings").select("nav_config").eq("user_id", userId).maybeSingle();
      const navConfig = settings?.nav_config || {};
      const initialBalances = navConfig.initialBalances || {};

      for (const w of rawWallets) {
        if (initialBalances[w.id] === undefined) {
          initialBalances[w.id] = (Number(w.balance) || 0) - (sums[w.id] || 0);
        }
        const newBalance = (Number(initialBalances[w.id]) || 0) + (sums[w.id] || 0);
        if (w.balance !== newBalance) {
          await db.from("wallets").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("id", w.id);
        }
      }
    }

    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Koreksi saldo berhasil disimpan!`, msg.messageId);
    return;
  }

  // Pendeteksian Input Batching dengan Optimistic Concurrency Control (Mencegah Kehilangan Data)
  let retries = 5;
  let saved = false;

  while (retries > 0 && !saved) {
    const { session: currentSession } = await getV2Session(db, waChatId);
    if (!currentSession) break;

    const pendingInputs = currentSession.session_data.pending_batch_inputs || [];
    if (msg.type === "image" && msg.mediaId) {
      pendingInputs.push({ type: "image", mediaId: msg.mediaId, caption: msg.caption });
    } else if (msg.type === "text") {
      pendingInputs.push({ type: "text", text });
    }

    const updatedData = {
      ...currentSession.session_data,
      pending_batch_inputs: pendingInputs,
      last_input_at: Date.now()
    };

    const { data: writeRes, error } = await db
      .from("wa_mode_sessions")
      .update({
        session_data: updatedData,
        updated_at: new Date().toISOString()
      })
      .eq("wa_chat_id", waChatId)
      .eq("updated_at", currentSession.updated_at)
      .select();

    if (!error && writeRes && writeRes.length > 0) {
      saved = true;
    } else {
      retries--;
      await new Promise(resolve => setTimeout(resolve, 80)); // jeda delay retry
    }
  }

  // Jadwalkan pemrosesan batch di background
  EdgeRuntime.waitUntil(
    (async () => {
      const delay = 4000; // jeda batch 4 detik
      await new Promise(resolve => setTimeout(resolve, delay));
      await processModeKoreksiBatch(db, apiKeys, waChatId, msg.messageId, userId);
    })()
  );
}

/**
 * Pemrosesan Debounced Batch untuk input mode koreksi dengan perlindungan bubble ganda
 */
export async function processModeKoreksiBatch(
  db: SupabaseClient,
  apiKeys: string[],
  waChatId: string,
  triggerMsgId: string,
  userId: string,
): Promise<void> {
  const { session, wasTimedOut } = await getV2Session(db, waChatId);
  if (!session || wasTimedOut) return;

  const data = session.session_data;
  if (!data.pending_batch_inputs || data.pending_batch_inputs.length === 0) return;

  const now = Date.now();
  const lastInputAt = data.last_input_at || 0;
  if (now - lastInputAt < 3800) {
    // Sesi baru terdeteksi, trigger batch dibatalkan untuk diganti batch berikutnya
    return;
  }

  // Optimistic Concurrency Control (OCC) Claiming: Hanya satu request yang boleh mengklaim list batch
  const { data: claimResult, error: claimError } = await db
    .from("wa_mode_sessions")
    .update({
      session_data: {
        ...data,
        pending_batch_inputs: [] // Kosongkan antrean
      },
      updated_at: new Date().toISOString()
    })
    .eq("wa_chat_id", waChatId)
    .eq("updated_at", session.updated_at) // Pastikan row tidak diubah oleh thread lain
    .select();

  if (claimError || !claimResult || claimResult.length === 0) {
    // Gagal melakukan claim (sudah diklaim oleh request thread/gelembung lain) → Exit!
    return;
  }

  const inputs = [...data.pending_batch_inputs];
  const mediaParts: any[] = [];
  let combinedText = "";

  for (const input of inputs) {
    if (input.type === "image") {
      try {
        const { data: bytes, mimeType } = await downloadWhatsAppMedia(input.mediaId, WA_ACCESS_TOKEN);
        if (bytes) {
          const b64 = safeBytesToBase64(bytes);
          mediaParts.push({
            inlineData: { mimeType: mimeType || "image/jpeg", data: b64 }
          });
        }
      } catch (e) {
        console.error("Gagal download media in batch:", e);
      }
      if (input.caption) {
        combinedText += "\n" + input.caption;
      }
    } else if (input.type === "text") {
      combinedText += "\n" + input.text;
    }
  }

  combinedText = combinedText.trim();

  const wallets = await v2GetWallets(db, userId);
  const draftItems = data.items || [];
  const selectedWallets = wallets.filter(w => data.selected_wallets.includes(w.id));

  await logToDb(db, "processModeKoreksiBatch: Calling Gemini", {
    combinedText,
    mediaPartsCount: mediaParts.length,
    selectedWallets: selectedWallets.map(w => w.name),
    draftItems
  });

  // Jalankan Gemini untuk mendeteksi semua updates di dalam batch
  const detectedItems = await parseKoreksiAction(apiKeys, combinedText, mediaParts, selectedWallets, draftItems);

  await logToDb(db, "processModeKoreksiBatch: Gemini Response", { detectedItems });

  if (detectedItems.length === 0) {
    // Berikan bubble informasi agar user tahu bahwa pembacaan tidak terdeteksi (tidak silent)
    const walletNames = selectedWallets.map(w => w.name).join(", ");
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Tidak terdeteksi nominal saldo untuk dompet terpilih (${walletNames}) dari foto/kalimat yang dikirim.\n\n` +
      `Silakan ketik nominal manual (contoh: '1 50rb') atau pastikan foto memuat saldo dompet tersebut.`,
      triggerMsgId
    );
    return;
  }

  // Kelompokkan hasil deteksi sub-akun berdasarkan wallet_id tujuan
  const grouped: Record<string, { wallet_id: string, wallet_name: string, breakdown: any[] }> = {};

  for (const item of detectedItems) {
    const wallet = selectedWallets.find(w => w.id === item.target_wallet_id);
    if (!wallet) continue;

    if (!grouped[wallet.id]) {
      grouped[wallet.id] = {
        wallet_id: wallet.id,
        wallet_name: wallet.name,
        breakdown: []
      };
    }

    const existing = grouped[wallet.id].breakdown.find(b => b.name.toLowerCase() === item.account_name.toLowerCase());
    if (existing) {
      existing.amount = item.amount;
    } else {
      grouped[wallet.id].breakdown.push({
        name: item.account_name,
        amount: item.amount
      });
    }
  }

  let updatedDraft = [...draftItems];

  for (const walletId in grouped) {
    const group = grouped[walletId];
    const existingIdx = updatedDraft.findIndex(d => d.wallet_id === walletId);

    if (existingIdx >= 0) {
      const currentBreakdown = updatedDraft[existingIdx].breakdown || [];
      for (const newB of group.breakdown) {
        const bIdx = currentBreakdown.findIndex(b => b.name.toLowerCase() === newB.name.toLowerCase());
        if (bIdx >= 0) {
          currentBreakdown[bIdx].amount = newB.amount;
        } else {
          currentBreakdown.push(newB);
        }
      }
      updatedDraft[existingIdx].breakdown = currentBreakdown;
      updatedDraft[existingIdx].amount = currentBreakdown.reduce((sum, b) => sum + b.amount, 0);
    } else {
      updatedDraft.push({
        wallet_id: walletId,
        wallet_name: group.wallet_name,
        breakdown: group.breakdown,
        amount: group.breakdown.reduce((sum, b) => sum + b.amount, 0)
      });
    }
  }

  // Tulis ulang draft hasil update ke database dengan lock OCC
  let updatedSessionData = null;
  let saveRetries = 5;
  let savedDraft = false;

  while (saveRetries > 0 && !savedDraft) {
    const { session: currentSession } = await getV2Session(db, waChatId);
    if (!currentSession) break;

    updatedSessionData = {
      ...currentSession.session_data,
      items: updatedDraft
    };

    const { data: writeRes, error } = await db
      .from("wa_mode_sessions")
      .update({
        session_data: updatedSessionData,
        updated_at: new Date().toISOString()
      })
      .eq("wa_chat_id", waChatId)
      .eq("updated_at", currentSession.updated_at)
      .select();

    if (!error && writeRes && writeRes.length > 0) {
      savedDraft = true;
    } else {
      saveRetries--;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  // Cetak draft dengan rekap totals terstruktur
  let report = `*Draft Koreksi Saldo*\n\n`;
  if (updatedDraft.length === 0) {
    report += `(kosong)\n`;
  } else {
    updatedDraft.forEach((item, idx) => {
      const orig = wallets.find(w => w.id === item.wallet_id);
      const systemBalance = orig ? Number(orig.balance) : 0;
      const diff = item.amount - systemBalance;
      const diffStr = diff === 0 ? "Rp0" : (diff < 0 ? `-${formatRupiah(Math.abs(diff))}` : `+${formatRupiah(diff)}`);
      
      report += `${idx + 1}. *${item.wallet_name}*\n`;
      if (item.breakdown && item.breakdown.length > 0) {
        item.breakdown.forEach(b => {
          report += `   • ${b.name}: ${formatRupiah(b.amount)}\n`;
        });
      }
      report += `   Saldo sistem : ${formatRupiah(systemBalance)}\n` +
                `   Saldo aktual : ${formatRupiah(item.amount)}\n` +
                `   Selisih      : ${diffStr}\n\n`;
    });

    let totalSystem = 0;
    let totalActual = 0;
    
    updatedDraft.forEach((item) => {
      const orig = wallets.find(w => w.id === item.wallet_id);
      totalSystem += orig ? Number(orig.balance) : 0;
      totalActual += item.amount;
    });
    
    const totalDiff = totalActual - totalSystem;
    const totalDiffStr = totalDiff === 0 ? "Rp0" : (totalDiff < 0 ? `-${formatRupiah(Math.abs(totalDiff))}` : `+${formatRupiah(totalDiff)}`);
    
    report += `-------------------------\n` +
              `*Total Saldo Aktual:* ${formatRupiah(totalActual)}\n` +
              `*Saldo Tercatat di App:* ${formatRupiah(totalSystem)}\n` +
              `*Selisih (Penyesuaian):* ${totalDiffStr}\n\n`;
  }

  report += `Ketik nomor/nama + nilai baru untuk mengubah (misal: '1 60rb'), atau ketik *"ya"* untuk memproses, *"batal"* untuk keluar.`;
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, report, triggerMsgId);
}

// ============================================================
// MODE 2: LIMIT BUDGET
// ============================================================

async function renderLimitList(db: SupabaseClient, categories: any[], userId: string): Promise<string> {
  const todayStr = getTodayStr();
  const currentMonth = todayStr.slice(0, 7);
  const budgets = await v2GetBudgets(db, userId, currentMonth);

  const { data: transactions } = await db
    .from("transactions")
    .select("category, amount")
    .eq("user_id", userId)
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
  const sortedCats = sortExpenseCategories(expenseCats, budgets);

  sortedCats.forEach((c, idx) => {
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
  messageId: string,
  userId: string
): Promise<void> {
  const categories = await v2GetCategories(db, userId);
  const text = await renderLimitList(db, categories, userId);
  
  await saveV2Session(db, waChatId, userId, "limit", {});
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeLimitMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any,
  userId: string
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Keluar dari mode limit anggaran.`, msg.messageId);
    return;
  }

  const categories = await v2GetCategories(db, userId);
  const todayStr = getTodayStr();
  const currentMonth = todayStr.slice(0, 7);
  const budgets = await v2GetBudgets(db, userId, currentMonth);

  const expenseCats = categories.filter(c => c.type === "expense");
  const sortedCats = sortExpenseCategories(expenseCats, budgets);

  const budgetList = sortedCats.map(c => {
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
    const matches = findCategoryByName(parsedAction.category_name, sortedCats);
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
  } else {
    // Add / Edit
    if (amount <= 0) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Nominal limit tidak valid.`, msg.messageId);
      return;
    }

    if (targetCat.budget_id) {
      // Update
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
        user_id: userId,
        access_code: "wa_" + userId,
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
  const updatedText = await renderLimitList(db, categories, userId);
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Ada lagi yang mau disesuaikan? Ketik 'batal' jika sudah selesai.\n\n` + updatedText, msg.messageId);
}

// ============================================================
// MODE 3: TUJUAN TABUNGAN
// ============================================================

async function renderGoalsList(db: SupabaseClient, userId: string): Promise<string> {
  const goals = await v2GetSavingsGoals(db, userId);
  const sortedGoals = sortGoals(goals);
  const wallets = await v2GetWallets(db, userId);

  let text = `Daftar Tujuan Tabungan:\n\n`;
  if (sortedGoals.length === 0) {
    text += `(kosong)\n`;
  } else {
    sortedGoals.forEach((g, idx) => {
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
  messageId: string,
  userId: string
): Promise<void> {
  const text = await renderGoalsList(db, userId);
  
  await saveV2Session(db, waChatId, userId, "tujuan", {});
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, text, messageId);
}

export async function handleModeTujuanMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  session: any,
  userId: string
): Promise<void> {
  const waChatId = session.wa_chat_id;
  const text = msg.text ?? "";
  const cleaned = text.trim().toLowerCase();

  if (cleaned === "batal") {
    await clearV2Session(db, waChatId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Keluar dari mode tujuan tabungan.`, msg.messageId);
    return;
  }

  const goals = await v2GetSavingsGoals(db, userId);
  const sortedGoals = sortGoals(goals);
  const parsedAction = await parseTujuanAction(apiKeys, text, sortedGoals);

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
    if (idx >= 0 && idx < sortedGoals.length) {
      targetGoal = sortedGoals[idx];
    }
  } else if (parsedAction.goal_name) {
    const matches = findGoalByName(parsedAction.goal_name, sortedGoals);
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
    await db.from("savings_goals").delete().eq("id", targetGoal.id).eq("user_id", userId);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Tujuan tabungan "${targetGoal.name}" berhasil dihapus.`, msg.messageId);
  } else if (parsedAction.action === "add") {
    if (!parsedAction.goal_name || !(parsedAction.amount > 0)) {
      await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Format tambah tujuan tidak lengkap. Sebutkan nama & nominal target.`, msg.messageId);
      return;
    }

    const walletId = `wa_w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("wallets").insert({
      id: walletId,
      user_id: userId,
      access_code: "wa_" + userId,
      name: `Tabungan ${parsedAction.goal_name}`,
      balance: 0,
      updated_at: new Date().toISOString()
    });

    const goalId = `wa_g_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.from("savings_goals").insert({
      id: goalId,
      user_id: userId,
      access_code: "wa_" + userId,
      name: parsedAction.goal_name,
      target_amount: parsedAction.amount,
      wallet_id: walletId,
      updated_at: new Date().toISOString()
    });

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Tujuan tabungan new "${parsedAction.goal_name}" berhasil dibuat dengan target ${formatRupiah(parsedAction.amount)}.`,
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
      .eq("id", targetGoal.id)
      .eq("user_id", userId);

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Tujuan tabungan "${targetGoal.name}" diubah targetnya menjadi ${formatRupiah(amount)}.`,
      msg.messageId
    );
  }

  // Cetak ulang list terupdate
  const updatedText = await renderGoalsList(db, userId);
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, `Ada lagi yang mau disesuaikan? Ketik 'batal' jika sudah selesai.\n\n` + updatedText, msg.messageId);
}
