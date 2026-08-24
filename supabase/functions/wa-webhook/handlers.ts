// supabase/functions/wa-webhook/handlers.ts
// Logic per tipe pesan WA: text, foto, voice note, reply-to-edit/delete,
// cek saldo, hapus terakhir, pesan ambigu

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  GeminiPart,
  ParsedTransaction,
  parseTransactions,
  parseEditInstruction,
  generateNaturalResponse,
  getTodayStr,
  formatRupiah,
  formatTanggalID,
  annotateSlangNominalForAi,
  generateClarificationQuestion,
  reclassifyCategory,
  cleanClarifiedNote,
  parseClarificationReply,
  matchHistoryAmountWithAi,
  transcribeAudioToText,
} from "./gemini.ts";
import { sendWhatsAppMessage, sendPushNotification, sendUserResponse, downloadWhatsAppMedia, safeBytesToBase64, chatContext } from "./whatsapp.ts";
import { processV2Query } from "./v2_query.ts";

// Regex sama persis dengan yang dipakai untuk pesan teks di v2_router.ts —
// dipusatkan di sini supaya alur audio (voice note) & teks konsisten.
const CEK_SALDO_REGEX = /^(cek saldo|saldo|berapa saldo|total saldo)/i;

// Setelah voice note ditranskrip, jalankan pengecekan intent QUERY yang sama
// dengan pesan teks (cek saldo langsung / pertanyaan bebas pakai "?") SEBELUM
// dianggap sebagai instruksi transaksi. Return true kalau sudah ditangani.
async function handleAudioTranscriptAsQueryIfApplicable(
  db: SupabaseClient,
  apiKeys: string[],
  transcript: string,
  waChatId: string,
  replyToMsgId: string,
  userId: string,
): Promise<boolean> {
  const trimmed = transcript.trim();
  if (!trimmed) return false;

  if (CEK_SALDO_REGEX.test(trimmed) && !trimmed.includes("?")) {
    await handleCekSaldo(db, waChatId, replyToMsgId, userId);
    return true;
  }

  if (trimmed.includes("?")) {
    const reply = await processV2Query(db, apiKeys, userId, trimmed);
    await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, reply, replyToMsgId);
    return true;
  }

  return false;
}

// ============================================================
// KONFIGURASI TETAP
// ============================================================

const ACCESS_CODE = Deno.env.get("WA_ACCESS_CODE") ?? "";
const DEFAULT_WALLET_ID = Deno.env.get("WA_DEFAULT_WALLET_ID") ?? "";
const OWNER_PHONE = Deno.env.get("WA_OWNER_PHONE") ?? "6281226964679"; // 081226964679 → E.164
const PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Batching: tunggu 3 detik setelah foto pertama sebelum proses
const BATCH_WINDOW_MS = 3000;

// ============================================================
// TIPE INTERNAL
// ============================================================

export interface IncomingMessage {
  messageId: string;
  from: string; // nomor pengirim E.164
  type: "text" | "image" | "audio" | "other";
  text?: string;
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  contextId?: string; // message_id dari pesan yang di-reply (kalau ini adalah reply)
}

export interface QueuedMediaItem {
  mediaId: string;
  mimeType: string;
  kind: "image" | "audio";
  caption?: string;
}

export interface WalletRow {
  id: string;
  name: string;
  balance: number;
  is_primary?: boolean;
  sort_order?: number;
}

// Hasil parseTransactions yang dijalankan lebih awal (paralel) oleh v2_router.ts,
// dipakai handleTextMessage kalau ada supaya tidak fetch+parse dua kali.
export interface SpeculativeParseResult {
  cats: CategoryRow[];
  wallets: WalletRow[];
  items: ParsedTransaction[];
}

export interface CategoryRow {
  id: string;
  name: string;
  type: "expense" | "income";
}

interface TransactionRow {
  id: string;
  wallet_id: string;
  category_id: string;
  category: string;
  type: "expense" | "income";
  amount: number;
  date: string;
  note: string;
  source: string;
}

// ============================================================
// HELPER: Generate UID sederhana
// ============================================================

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ============================================================
// HELPER: Fetch kategori & dompet dari Supabase
// ============================================================

async function getDeletedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data } = await db
    .from("user_settings")
    .select("deleted_ids")
    .eq("user_id", userId)
    .maybeSingle();
  return new Set((data?.deleted_ids || []).map(String));
}

export async function getCategories(db: SupabaseClient, userId: string): Promise<CategoryRow[]> {
  const deletedSet = await getDeletedIds(db, userId);
  const code = "wa_" + userId;
  const { data } = await db.from("categories").select("id, name, type").or(`user_id.eq.${userId},access_code.eq.${code}`);
  let rows = (data ?? []) as CategoryRow[];
  rows = rows.filter(r => !deletedSet.has(String(r.id)));
  if (rows.length === 0) {
    const { data: sysCats } = await db.from("categories").select("id, name, type").limit(20);
    if (sysCats && sysCats.length > 0) return sysCats as CategoryRow[];
  }
  return rows;
}

export async function getWallets(db: SupabaseClient, userId: string): Promise<WalletRow[]> {
  const deletedSet = await getDeletedIds(db, userId);
  const code = "wa_" + userId;
  const { data } = await db.from("wallets").select("id, name, balance, is_primary, sort_order").or(`user_id.eq.${userId},access_code.eq.${code}`);
  let rows = (data ?? []) as WalletRow[];
  rows = rows.filter(r => !deletedSet.has(String(r.id)));
  if (rows.length === 0) {
    return [{ id: "wallet_utama", name: "Dompet Utama", balance: 0, is_primary: true, sort_order: 1 }];
  }
  return rows;
}

// ============================================================
// HELPER: Match kategori by name
// ============================================================

function matchCategoryId(
  name: string | undefined,
  type: "expense" | "income",
  cats: CategoryRow[],
): string {
  const typeCats = cats.filter((c) => c.type === type);
  let cat = name
    ? typeCats.find((c) => c.name.toLowerCase() === (name ?? "").toLowerCase())
    : null;
  if (!cat) cat = typeCats.find((c) => c.name.toLowerCase() === "lainnya");
  if (!cat) cat = typeCats[0];
  return cat?.id ?? "";
}

// ============================================================
// HELPER: Match dompet by name (untuk mention eksplisit)
// ============================================================

function getDefaultWalletId(wallets: WalletRow[]): string {
  const envDefault = Deno.env.get("WA_DEFAULT_WALLET_ID");
  if (envDefault && wallets.some(w => w.id === envDefault)) {
    return envDefault;
  }
  const primary = wallets.find(w => w.is_primary);
  if (primary) return primary.id;
  const utama = wallets.find(w => w.id === "wallet_utama");
  if (utama) return utama.id;
  if (wallets.length > 0) return wallets[0].id;
  return "wallet_utama";
}

function matchWalletId(
  mentionedName: string | undefined,
  wallets: WalletRow[],
): string {
  const defId = getDefaultWalletId(wallets);
  if (!mentionedName) return defId;
  // Cek apakah ada dompet yang namanya mengandung kata dari mention
  const lower = mentionedName.toLowerCase();
  const found = wallets.find(
    (w) =>
      w.name.toLowerCase().includes(lower) ||
      lower.includes(w.name.toLowerCase()),
  );
  return found?.id ?? defId;
}

function findWalletId(
  mentionedName: string | undefined,
  wallets: WalletRow[],
): string | undefined {
  if (!mentionedName) return undefined;
  const lower = mentionedName.toLowerCase();
  return wallets.find(
    (w) =>
      w.name.toLowerCase().includes(lower) ||
      lower.includes(w.name.toLowerCase()),
  )?.id;
}

// ============================================================
// HELPER: Cari nominal dari histori (reuse logika applyAiHistoryAmountFallback)
// ============================================================

async function findHistoryAmount(
  db: SupabaseClient,
  apiKeys: string[],
  note: string,
  categoryId: string,
  type: "expense" | "income",
  userId: string,
): Promise<number | null> {
  const { data: txs } = await db
    .from("transactions")
    .select("amount, note, date, category_id")
    .eq("user_id", userId)
    .eq("type", type)
    .eq("category_id", categoryId)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(100);

  if (!txs?.length) return null;

  const normalize = (s: string) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const rowNorm = normalize(note);

  // 1. Exact match (kategori sama)
  const exactMatch = txs.find((t) => normalize(t.note) === rowNorm);
  if (exactMatch) return exactMatch.amount;

  // 2. Gunakan AI untuk mencocokkan riwayat dalam kategori ini secara pintar
  const historyItems = txs.map((t) => ({ amount: Number(t.amount), note: t.note }));
  const matchedAmount = await matchHistoryAmountWithAi(apiKeys, note, historyItems);
  return matchedAmount;
}

// ============================================================
// HELPER: Scaling proporsional untuk groupId/groupTotal
// ============================================================

function applyGroupScaling(rows: TransactionRow[]): void {
  const groups: Record<string, TransactionRow[]> = {};
  for (const r of rows) {
    if ((r as Record<string, unknown>)._groupId) {
      const gid = (r as Record<string, unknown>)._groupId as string;
      groups[gid] = groups[gid] ?? [];
      groups[gid].push(r);
    }
  }

  for (const members of Object.values(groups)) {
    const total = (members[0] as Record<string, unknown>)._groupTotal as number;
    if (!(total > 0)) continue;
    const weightOf = (r: TransactionRow) => (r.amount > 0 ? r.amount : 1);
    const weightSum = members.reduce((s, r) => s + weightOf(r), 0);
    if (!(weightSum > 0)) continue;

    let scaledSum = 0;
    for (const r of members) {
      r.amount = Math.round((weightOf(r) / weightSum) * total);
      scaledSum += r.amount;
    }
    const diff = total - scaledSum;
    if (diff !== 0) {
      const maxR = members.reduce((a, b) => (a.amount > b.amount ? a : b));
      maxR.amount += diff;
    }
  }
}

// ============================================================
// HELPER: Format bubble konfirmasi (3 kelompok, sesuai PRD 5.6)
// ============================================================

function formatConfirmBubble(
  tx: TransactionRow,
  walletName: string,
  walletBalance: number,
  isUpdated = false,
): string {
  const label = isUpdated ? "Transaksi diperbarui" : "Transaksi tercatat";
  const typeLabel =
    tx.type === "income"
      ? `Pemasukan: ${formatRupiah(tx.amount)}`
      : `Pengeluaran: ${formatRupiah(tx.amount)}`;

  let msg = `${label}\nTanggal: ${formatTanggalID(tx.date)}\n\n`;
  msg += `${typeLabel}\nKategori: ${tx.category}\n`;
  if (tx.note) msg += `Keterangan: ${tx.note}\n`;
  msg += `\nDompet: ${walletName}\nSisa dompet: ${formatRupiah(walletBalance)}`;

  return msg;
}

async function recordDeletionInDb(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<void> {
  if (!id) return;
  const { data: settings } = await db
    .from("user_settings")
    .select("deleted_ids")
    .eq("user_id", userId)
    .maybeSingle();

  let deletedIds: string[] = [];
  if (settings && Array.isArray(settings.deleted_ids)) {
    deletedIds = settings.deleted_ids.map(String);
  }

  if (!deletedIds.includes(id)) {
    deletedIds.push(id);
    await db
      .from("user_settings")
      .update({
        deleted_ids: deletedIds,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }
}

async function recalculateDbWalletBalances(
  db: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data: wallets } = await db
    .from("wallets")
    .select("*")
    .eq("user_id", userId);
  const { data: transactions } = await db
    .from("transactions")
    .select("*")
    .eq("user_id", userId);

  if (!wallets || !transactions) return;

  const { data: settings } = await db
    .from("user_settings")
    .select("nav_config, deleted_ids")
    .eq("user_id", userId)
    .maybeSingle();

  const deletedIds = Array.isArray(settings?.deleted_ids) ? settings.deleted_ids.map(String) : [];
  const deletedSet = new Set(deletedIds);

  const sums: Record<string, number> = {};
  for (const w of wallets) {
    sums[w.id] = 0;
  }

  const todayStr = getTodayStr();

  for (const t of transactions) {
    if (deletedSet.has(String(t.id))) continue; // Skip deleted transactions!
    const isFuture = t.date > todayStr;
    if (isFuture) continue;

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

  let settingsChanged = false;

  for (const w of wallets) {
    if (initialBalances[w.id] === undefined) {
      initialBalances[w.id] = (Number(w.balance) || 0) - (sums[w.id] || 0);
      settingsChanged = true;
    }
    const newBalance = (Number(initialBalances[w.id]) || 0) + (sums[w.id] || 0);
    if (w.balance !== newBalance) {
      await db
        .from("wallets")
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq("id", w.id);
    }
  }

  if (settingsChanged) {
    navConfig.initialBalances = initialBalances;
    await db
      .from("user_settings")
      .update({ nav_config: navConfig, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }
}

function findMentionedWallet(text: string, wallets: WalletRow[]): string | undefined {
  const lowerText = text.toLowerCase();
  for (const w of wallets) {
    const lowerName = w.name.toLowerCase();
    if (lowerText.includes(lowerName)) {
      return w.name;
    }
    const words = lowerName.split(/\s+/).filter(word => word.length > 2 && word !== "dompet" && word !== "rekening");
    for (const word of words) {
      if (lowerText.includes(word)) {
        return w.name;
      }
    }
  }
  return undefined;
}

// ============================================================
// HELPER: Simpan transaksi ke Supabase + update balance
// ============================================================
async function saveTx(
  db: SupabaseClient,
  tx: Omit<TransactionRow, "id"> & { id?: string },
  wallets: WalletRow[],
  userId: string,
): Promise<{ savedTx: TransactionRow; updatedWallet: WalletRow }> {
  const id = tx.id ?? `wa_tx_${uid()}`;
  const row: TransactionRow = { ...tx, id } as TransactionRow;

  const { error: txErr } = await db.from("transactions").insert({
    id,
    user_id: userId,
    access_code: "wa_" + userId,
    wallet_id: row.wallet_id,
    category_id: row.category_id,
    category: row.category,
    type: row.type,
    amount: row.amount,
    date: row.date,
    note: row.note,
    source: "whatsapp",
    updated_at: new Date().toISOString(),
  });

  if (txErr) throw new Error(`Gagal simpan transaksi: ${txErr.message}`);

  // Recalculate balances murni from database transactions!
  await recalculateDbWalletBalances(db, userId);

  // Fetch the updated wallet to return it
  const { data: updatedW } = await db
    .from("wallets")
    .select("*")
    .eq("id", row.wallet_id)
    .single();

  const finalWallet = (updatedW as WalletRow) || wallets.find((w) => w.id === row.wallet_id) || wallets[0];

  return {
    savedTx: row,
    updatedWallet: finalWallet,
  };
}

// ============================================================
// HELPER: Simpan mapping wa_message_id ↔ transaction_id
// ============================================================

async function saveMapping(
  db: SupabaseClient,
  waMessageId: string,
  transactionId: string,
  userId: string,
): Promise<void> {
  await db.from("wa_message_transactions").insert({
    wa_message_id: waMessageId,
    transaction_id: transactionId,
    user_id: userId,
    access_code: "wa_" + userId,
  });
}

// ============================================================
// PROSES: Kirim balasan konfirmasi per transaksi
// ============================================================

async function sendAndMapTx(
  db: SupabaseClient,
  tx: TransactionRow,
  wallets: WalletRow[],
  waChatId: string,
  replyToMsgId?: string,
  isUpdated = false,
  userId = "",
): Promise<void> {
  const wallet = wallets.find((w) => w.id === tx.wallet_id) ?? wallets[0];
  const bubble = formatConfirmBubble(
    tx,
    wallet.name,
    wallet.balance,
    isUpdated,
  );

  const typeLabel = tx.type === "income" ? "Pemasukan" : "Pengeluaran";
  const noteOrCat = tx.note ? `${tx.note} (${tx.category})` : tx.category;
  const pushTitle = isUpdated ? "Transaksi diperbarui" : "Transaksi baru tercatat";
  const pushBody = `${typeLabel} · ${noteOrCat}\nRp${tx.amount.toLocaleString("id-ID")} · ${wallet.name}`;
  const editUrl = `./?shortcut=edit-tx&id=${encodeURIComponent(tx.id)}`;
  // Tap area notifikasi (bukan tombol) yang jadi trigger Edit/Lengkapi — ditangani lewat
  // fallback data.url di sw.js (notificationclick). Tombol "Hapus" tetap dipertahankan
  // sebagai satu-satunya action button, baik untuk transaksi lengkap maupun draft.
  const actions = [{ action: "delete", title: "Hapus" }];
  const actionUrls = {};

  const pushPayload = {
    title: pushTitle,
    body: pushBody,
    data: {
      action: isUpdated ? "edit" : "save",
      transaction_id: tx.id,
      user_id: userId,
      actions,
      actionUrls,
      url: editUrl,
      requireInteraction: true
    }
  };

  const sentMsgId = await sendUserResponse(
    db,
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    userId,
    waChatId,
    bubble,
    replyToMsgId,
    pushPayload
  );

  if (sentMsgId && userId) {
    await saveMapping(db, sentMsgId, tx.id, userId);
  }
}

// ============================================================
// HANDLER UTAMA: Proses parsed transactions (simpan + balas)
// ============================================================

async function processParsedItems(
  db: SupabaseClient,
  apiKeys: string[],
  items: ParsedTransaction[],
  cats: CategoryRow[],
  wallets: WalletRow[],
  waChatId: string,
  incomingMsgId: string,
  mentionedWalletName?: string,
  isFromMedia = false,
  userId = "",
): Promise<void> {
  const today = getTodayStr();

  // 1. Match categories and type for all items first so we can group/merge them properly
  const matchedItems = items.map(it => {
    const type: "expense" | "income" = it.type === "income" ? "income" : "expense";
    const catId = matchCategoryId(it.category, type, cats);
    const catName = cats.find((c) => c.id === catId)?.name ?? it.category ?? "Lainnya";
    return {
      ...it,
      type,
      catId,
      catName
    };
  });

  // 2. Group by matched category (type + catId)
  const finalMergedItems: typeof matchedItems = [];
  const groups: Record<string, typeof matchedItems> = {};

  for (const it of matchedItems) {
    // PENGECUALIAN KHUSUS kategori "Lainnya": barang-barang yang masuk kategori "Lainnya" TETAP dipisah
    if (it.catName.toLowerCase() === "lainnya") {
      finalMergedItems.push(it);
      continue;
    }

    const key = `${it.type}_${it.catId}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(it);
  }

  for (const key in groups) {
    const group = groups[key];
    if (group.length === 1) {
      finalMergedItems.push(group[0]);
    } else {
      const first = group[0];
      const mergedAmount = group.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      
      // Merge notes cleanly (detecting common shop prefixes like "Alfamart - ", "Indomaret - ")
      const prefixRegex = /^(Alfamart|Indomaret|Alfamidi|Superindo|Toko|Warung|Grab|Gojek)\s*-\s*/i;
      const noteDetails: string[] = [];
      let commonPrefix = "";

      for (const item of group) {
        const noteText = (item.note ?? "").trim();
        if (!noteText) continue;
        const match = noteText.match(prefixRegex);
        if (match) {
          const prefix = match[0];
          if (!commonPrefix) {
            commonPrefix = prefix;
          } else if (commonPrefix.toLowerCase() !== prefix.toLowerCase()) {
            commonPrefix = "multiple";
          }
        } else {
          commonPrefix = "none";
        }
      }

      for (const item of group) {
        let noteText = (item.note ?? "").trim();
        if (!noteText) continue;
        if (commonPrefix && commonPrefix !== "multiple" && commonPrefix !== "none") {
          noteText = noteText.replace(prefixRegex, "");
        }
        if (noteText) noteDetails.push(noteText);
      }

      let finalNote = "";
      if (commonPrefix && commonPrefix !== "multiple" && commonPrefix !== "none" && noteDetails.length > 0) {
        finalNote = `${commonPrefix}${noteDetails.join(", ")}`;
      } else {
        finalNote = group.map(item => (item.note ?? "").trim()).filter(Boolean).join(", ");
      }

      finalMergedItems.push({
        ...first,
        amount: mergedAmount,
        note: finalNote
      });
    }
  }

  // Scaling proporsional untuk groupId
  const rawRows = finalMergedItems.map((it, idx) => {
    const walletId = matchWalletId(it.wallet || mentionedWalletName, wallets);
    return {
      _idx: idx,
      _groupId: it.groupId ?? null,
      _groupTotal: it.groupTotal ?? null,
      id: `wa_tx_${uid()}`,
      wallet_id: walletId,
      category_id: it.catId,
      category: it.catName,
      type: it.type,
      amount: Math.max(0, Math.round(Number(it.amount) || 0)),
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date ?? "") ? it.date! : today,
      note: (it.note ?? "").slice(0, 80),
      source: "whatsapp",
      isFromMedia,
    };
  });

  // Scaling proporsional
  applyGroupScaling(rawRows as unknown as TransactionRow[]);

  let waAutoReply = true;
  if (userId) {
    const { data: st } = await db.from("user_settings").select("wa_auto_reply").eq("user_id", userId).maybeSingle();
    if (st && typeof st.wa_auto_reply === "boolean") {
      waAutoReply = st.wa_auto_reply;
    }
  }

  // Toggle "Balasan WA" cuma relevan buat nomor WhatsApp asli (WA ON = balas via chat WA,
  // WA OFF = balas via push notification HP). Chat AI di app WAJIB selalu balas di jendela
  // chat-nya sendiri, terlepas dari toggle ini sama sekali — kalau tidak, chat app kelihatan
  // "gak ada balasan dari server" padahal sebenarnya notif push terkirim ke HP (di luar chat
  // yang sedang dibuka user), bukan gagal beneran.
  const store = chatContext.getStore();
  const isWebChat = !!(store && store.isWebChat);

  for (const row of rawRows) {
    const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
    const isNoteGeneric = !row.note || genericNotes.includes(row.note.toLowerCase().trim());

    if (row.amount === 0) {
      let histAmt = null;
      if (!isNoteGeneric) {
        histAmt = await findHistoryAmount(
          db,
          apiKeys,
          row.note,
          row.category_id,
          row.type,
          userId,
        );
      }

      if (histAmt && histAmt > 0) {
        row.amount = histAmt;
      } else {
        if (!waAutoReply && !isWebChat) {
          const draftRow = { ...row, is_draft: true };
          const { savedTx } = await saveTx(db, draftRow as unknown as TransactionRow, wallets, userId);
          await sendPushNotification(
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            userId,
            "Transaksi butuh dilengkapi",
            `${row.type === "income" ? "Pemasukan" : "Pengeluaran"} - ${row.note || row.category} (${row.category})\nNominal tidak diketahui\nKetuk untuk melengkapi (batal otomatis dalam 5 menit).`,
            { action: "lengkapi", transaction_id: savedTx.id }
          );
          continue;
        }

        const pendingId = `pend_${uid()}`;
        await db.from("wa_pending_transactions").insert({
          id: pendingId,
          user_id: userId,
          access_code: "wa_" + userId,
          wa_chat_id: waChatId,
          pending_data: JSON.stringify(row),
        });
        const questionText = await generateClarificationQuestion(apiKeys, {
          type: "amount",
          note: isNoteGeneric ? undefined : row.note,
        });

        const questionMsg = await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          questionText,
          incomingMsgId,
        );

        if (questionMsg) {
          await db
            .from("wa_pending_transactions")
            .update({ wa_question_message_id: questionMsg })
            .eq("id", pendingId);
        }
        continue;
      }
    }

    if (isNoteGeneric) {
      if (!waAutoReply && !isWebChat) {
        const draftRow = { ...row, note: "", is_draft: true };
        const { savedTx } = await saveTx(db, draftRow as unknown as TransactionRow, wallets, userId);
        await sendPushNotification(
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          userId,
          "Transaksi butuh dilengkapi",
          `Rp${row.amount.toLocaleString("id-ID")} terbaca, tetapi catatan belum lengkap. Ketuk notifikasi ini untuk melengkapi (batal otomatis dalam 5 menit).`,
          { action: "lengkapi", transaction_id: savedTx.id }
        );
        continue;
      }

      const pendingId = `pend_${uid()}`;
      row.note = "";
      await db.from("wa_pending_transactions").insert({
        id: pendingId,
        user_id: userId,
        access_code: "wa_" + userId,
        wa_chat_id: waChatId,
        pending_data: JSON.stringify(row),
      });

      let questionText = "";
      if (row.isFromMedia) {
        questionText = `Gagal membaca media yang kamu kirim, ${formatRupiah(row.amount)} ini buat bayar apa?`;
      } else {
        questionText = await generateClarificationQuestion(apiKeys, {
          type: "note",
          amount: row.amount,
        });
      }

      const questionMsg = await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        questionText,
        incomingMsgId,
      );

      if (questionMsg) {
        await db
          .from("wa_pending_transactions")
          .update({ wa_question_message_id: questionMsg })
          .eq("id", pendingId);
      }
      continue;
    }
    // Simpan ke Supabase
    const { savedTx, updatedWallet } = await saveTx(
      db,
      row as unknown as TransactionRow,
      wallets,
      userId,
    );

    // Kirim konfirmasi bubble
    const updatedWallets = wallets.map((w) =>
      w.id === updatedWallet.id ? updatedWallet : w,
    );
    await sendAndMapTx(db, savedTx, updatedWallets, waChatId, incomingMsgId, false, userId);

    // Update balance di array lokal supaya next tx pakai saldo terbaru
    const wIdx = wallets.findIndex((w) => w.id === updatedWallet.id);
    if (wIdx >= 0) wallets[wIdx] = updatedWallet;
  }
}

// ============================================================
// HANDLER: Pesan teks
// ============================================================

export async function handleTextMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  userId: string,
): Promise<void> {
  const text = msg.text ?? "";
  const today = getTodayStr();

  // Cek perintah khusus
  if (/^(cek saldo|saldo|berapa saldo|total saldo)/i.test(text.trim())) {
    await handleCekSaldo(db, msg.from, msg.messageId, userId);
    return;
  }

  const isCancelCommand = /^(batalkan|batal|hapus transaksi terakhir|hapus terakhir|hapus|undo|ga jadi|gajadi|cancel|batalin|delete|del|back)$/i.test(text.trim()) ||
    /^(tolong|mohon)?\s*(hapus|batalkan|cancel|undo|gajadi|ga jadi)\s*(transaksi|aja|catatan|terakhir|yang tadi)?$/i.test(text.trim());

  if (isCancelCommand) {
    await handleHapusTerakhir(db, msg.from, msg.messageId, userId);
    return;
  }

  // PRD 5.1a: jawaban nominal boleh dikirim sebagai pesan baru, bukan hanya reply.
  if (await handlePendingNominalMessage(db, apiKeys, msg, userId)) return;

  // OPTIMISASI KECEPATAN: kalau v2_router sudah menjalankan parseTransactions ini
  // secara paralel (background) sambil mengklasifikasi intent V2, pakai hasilnya
  // langsung di sini, bukan mulai dari nol. Logic/hasil akhir SAMA PERSIS -
  // cuma sumber data cats/wallets/items-nya beda (precomputed vs fetch baru).
  const speculative = (msg as {
    _speculativeTextParse?: Promise<SpeculativeParseResult | { error: Error }>;
  })._speculativeTextParse;

  let cats: CategoryRow[];
  let wallets: WalletRow[];
  let items: ParsedTransaction[];

  if (speculative) {
    const result = await speculative;
    if ("error" in result) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        msg.from,
        "Maaf, lagi ada gangguan baca pesannya, coba lagi ya.",
        msg.messageId,
      );
      return;
    }
    ({ cats, wallets, items } = result);
  } else {
    [cats, wallets] = await Promise.all([
      getCategories(db, userId),
      getWallets(db, userId),
    ]);
    const expenseCats = cats
      .filter((c) => c.type === "expense")
      .map((c) => c.name);
    const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

    // Coba parse sebagai transaksi
    const annotatedText = annotateSlangNominalForAi(text);
    const parts: GeminiPart[] = [{ text: `TEKS_BEBAS_DARI_USER: ${annotatedText}` }];

    try {
      items = await parseTransactions(
        apiKeys,
        parts,
        expenseCats,
        incomeCats,
        today,
      );
    } catch (e) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        msg.from,
        "Maaf, lagi ada gangguan baca pesannya, coba lagi ya.",
        msg.messageId,
      );
      return;
    }
  }

  if (!items.length) {
    // Pesan bukan transaksi → respons AI natural
    try {
      const reply = await generateNaturalResponse(apiKeys, text);
      await sendUserResponse(
        db,
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        userId,
        msg.from,
        reply,
        msg.messageId,
      );
    } catch {
      await sendUserResponse(
        db,
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        userId,
        msg.from,
        "Halo! Ada yang bisa dibantu?",
        msg.messageId,
      );
    }
    return;
  }

  const mentionedWalletName = findMentionedWallet(text, wallets);
  await processParsedItems(db, apiKeys, items, cats, wallets, msg.from, msg.messageId, mentionedWalletName, false, userId);
}

// ============================================================
// HANDLER: Foto (single atau dari batch)
// ============================================================

export async function handleMediaBatch(
  db: SupabaseClient,
  apiKeys: string[],
  mediaItems: QueuedMediaItem[],
  firstMsgId: string,
  waChatId: string,
  userId: string,
): Promise<void> {
  const today = getTodayStr();
  const [cats, wallets] = await Promise.all([
    getCategories(db, userId),
    getWallets(db, userId),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Gabungkan caption dari semua foto (caption apapun berlaku untuk seluruh batch)
  const captions = mediaItems
    .map((m) => m.caption)
    .filter(Boolean)
    .join(" ")
    .trim();

  // Batch berisi HANYA voice note (tanpa foto): transkrip dulu, lalu cek apakah
  // ini query ("cek saldo", pertanyaan pakai "?", dll) SEBELUM dianggap transaksi.
  // Ini menyamakan perlakuan voice note dengan pesan teks biasa.
  const hasImage = mediaItems.some((m) => m.kind === "image");
  const audioItems = mediaItems.filter((m) => m.kind === "audio");
  const audioOnly = !hasImage && audioItems.length > 0;
  const audioTranscripts: string[] = [];

  if (audioOnly) {
    for (const item of audioItems) {
      try {
        const { data, mimeType } = await downloadWhatsAppMedia(
          item.mediaId,
          WA_ACCESS_TOKEN,
        );
        const base64 = safeBytesToBase64(data);
        const t = await transcribeAudioToText(apiKeys, base64, mimeType);
        if (t) audioTranscripts.push(t);
      } catch (e) {
        console.error(`Gagal transkrip audio ${item.mediaId}:`, e);
      }
    }

    const transcriptCombined = [captions, ...audioTranscripts].filter(Boolean).join(" ").trim();
    if (transcriptCombined) {
      const handled = await handleAudioTranscriptAsQueryIfApplicable(
        db,
        apiKeys,
        transcriptCombined,
        waChatId,
        firstMsgId,
        userId,
      );
      if (handled) return;
    }
  }

  const parts: GeminiPart[] = [];
  const audioAlreadyTranscribed = audioOnly && audioTranscripts.length > 0;

  if (audioAlreadyTranscribed) {
    // Sudah ditranskrip & sudah lolos cek query di atas — pakai transkrip +
    // caption (kalau ada) sebagai satu teks, tidak perlu kirim ulang audio
    // mentah ke Gemini untuk ekstraksi transaksi.
    const combined = [captions, ...audioTranscripts].filter(Boolean).join(" ").trim();
    parts.push({ text: `TEKS_BEBAS_DARI_USER: ${combined}` });
  } else {
    // Download semua media di memori saja; tidak pernah ditulis ke Storage/disk.
    for (const item of mediaItems) {
      try {
        const { data, mimeType } = await downloadWhatsAppMedia(
          item.mediaId,
          WA_ACCESS_TOKEN,
        );
        const base64 = safeBytesToBase64(data);
        if (item.kind === "audio") {
          parts.push({
            text: "Lampiran berikut adalah voice note. Pahami audionya langsung dan ekstrak transaksi dalam panggilan ini; jangan membuat tahap transkripsi terpisah.",
          });
        }
        parts.push({ inlineData: { data: base64, mimeType } });
      } catch (e) {
        console.error(`Gagal download media ${item.mediaId}:`, e);
      }
    }

    if (captions) {
      parts.push({ text: `TEKS_BEBAS_DARI_USER: ${captions}` });
    }
  }

  if (!parts.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      firstMsgId,
    );
    return;
  }

  let items: ParsedTransaction[];
  try {
    items = await parseTransactions(
      apiKeys,
      parts,
      expenseCats,
      incomeCats,
      today,
    );
  } catch (e) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      firstMsgId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.",
      firstMsgId,
    );
    return;
  }

  const isFromMedia = mediaItems.some((m) => m.kind === "image");
  const mentionedWalletName = findMentionedWallet(captions, wallets);
  await processParsedItems(db, apiKeys, items, cats, wallets, waChatId, firstMsgId, mentionedWalletName, isFromMedia, userId);
}

// Ambil dan claim media yang sudah melewati jeda hening. Claim kondisional
// mencegah dua invocation yang bangun bersamaan memproses media yang sama.
export async function processQueuedMediaBatch(
  db: SupabaseClient,
  apiKeys: string[],
  chatId: string,
  userId: string,
): Promise<void> {
  const quietBefore = new Date(Date.now() - BATCH_WINDOW_MS).toISOString();
  // Debounce: bila masih ada media yang baru masuk, timer dari media terakhir
  // yang akan memproses semuanya sekaligus.
  const { data: newest } = await db
    .from("wa_media_queue")
    .select("received_at")
    .eq("user_id", userId)
    .eq("wa_chat_id", chatId)
    .is("processed_at", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!newest || newest.received_at > quietBefore) return;

  const { data: candidates, error } = await db
    .from("wa_media_queue")
    .select("wa_message_id, media_id, mime_type, media_kind, caption")
    .eq("user_id", userId)
    .eq("wa_chat_id", chatId)
    .is("processed_at", null)
    .is("processing_started_at", null)
    .order("received_at", { ascending: true });
  if (error || !candidates?.length) return;

  const claimed: typeof candidates = [];
  for (const item of candidates) {
    const { data } = await db
      .from("wa_media_queue")
      .update({ processing_started_at: new Date().toISOString() })
      .eq("wa_message_id", item.wa_message_id)
      .is("processing_started_at", null)
      .is("processed_at", null)
      .select("wa_message_id")
      .maybeSingle();
    if (data) claimed.push(item);
  }
  if (!claimed.length) return;

  try {
    await handleMediaBatch(
      db,
      apiKeys,
      claimed.map((item) => ({
        mediaId: item.media_id,
        mimeType: item.mime_type,
        kind: item.media_kind as "image" | "audio",
        caption: item.caption ?? undefined,
      })),
      claimed[0].wa_message_id,
      chatId,
      userId,
    );
    await db
      .from("wa_media_queue")
      .update({ processed_at: new Date().toISOString() })
      .in(
        "wa_message_id",
        claimed.map((item) => item.wa_message_id),
      );
  } catch (error) {
    await db
      .from("wa_media_queue")
      .update({ 
        processed_at: new Date().toISOString(),
        processing_started_at: null 
      })
      .in(
        "wa_message_id",
        claimed.map((item) => item.wa_message_id),
      );
    throw error;
  }
}

// ============================================================
// HANDLER: Voice note (audio OGG dari WhatsApp)
// ============================================================

export async function handleAudioMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  userId: string,
): Promise<void> {
  const today = getTodayStr();
  const [cats, wallets] = await Promise.all([
    getCategories(db, userId),
    getWallets(db, userId),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Download audio dari Meta
  let audioData: Uint8Array;
  let mimeType: string;

  try {
    const result = await downloadWhatsAppMedia(msg.mediaId!, WA_ACCESS_TOKEN);
    audioData = result.data;
    mimeType = result.mimeType || "audio/ogg";
  } catch {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  const base64Audio = safeBytesToBase64(audioData);

  const parts: GeminiPart[] = [
    {
      text: "CATATAN: lampiran audio berikut adalah rekaman suara (voice note) dari user berisi ucapan tentang transaksi. Dengarkan & transkripsikan isinya, lalu perlakukan hasilnya PERSIS seperti TEKS_BEBAS_DARI_USER sesuai semua aturan di atas (termasuk aturan pemecahan multi-transaksi tanpa pemisah eksplisit untuk transkrip suara yang mengalir panjang).",
    },
    {
      inlineData: { data: base64Audio, mimeType },
    },
  ];

  let items: ParsedTransaction[];
  try {
    items = await parseTransactions(
      apiKeys,
      parts,
      expenseCats,
      incomeCats,
      today,
    );
  } catch (e) {
    // Jika format OGG ditolak (HTTP 400), coba skip — tidak ada library konversi di edge function
    // Fallback: minta user kirim ulang sebagai teks
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      "Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  await processParsedItems(db, apiKeys, items, cats, wallets, msg.from, msg.messageId, undefined, false, userId);
}

// ============================================================
// HANDLER: Reply ke bubble transaksi (edit/delete)
// ============================================================

export async function handleReplyToTransaction(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  transactionId: string,
  userId: string,
): Promise<void> {
  const waChatId = msg.from;

  // ── VERSI 2: Intercept entri utang baru (tanpa transaksi) ──
  if (transactionId.startsWith("wa_debt_")) {
    const replyText = (msg.text ?? "").trim().toLowerCase();
    const isDirectDelete = /^(batalkan|batal|hapus|undo|ga jadi|gajadi|cancel|batalin|delete|del|back)$/i.test(replyText) ||
      /^(tolong|mohon)?\s*(hapus|batalkan|cancel|undo|gajadi|ga jadi)\s*(transaksi|aja|catatan|terakhir|yang tadi)?$/i.test(replyText);

    if (isDirectDelete) {
      const { data: debtData } = await db
        .from("debt_entries")
        .select("*")
        .eq("id", transactionId)
        .eq("user_id", userId)
        .maybeSingle();

      if (debtData) {
        await db.from("debt_entries").delete().eq("id", transactionId).eq("user_id", userId);
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          `Catatan utang ${debtData.person_name} sebesar ${formatRupiah(debtData.amount)} berhasil dihapus.`,
          msg.messageId
        );
      } else {
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          `Catatan utang tidak ditemukan atau sudah dihapus.`,
          msg.messageId
        );
      }
      return;
    } else {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Catatan utang baru hanya bisa dihapus/dibatalkan. Ketik 'hapus' untuk membatalkan.`,
        msg.messageId
      );
      return;
    }
  }

  // Ambil data transaksi dari Supabase
  const { data: txData, error } = await db
    .from("transactions")
    .select("*")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .single();

  if (error || !txData) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Transaksi tidak ditemukan. Mungkin sudah dihapus sebelumnya.",
      msg.messageId,
    );
    return;
  }

  let userReply: string | any[] = "";
  if (msg.type === "audio") {
    let audioData: Uint8Array;
    let mimeType: string;
    try {
      const result = await downloadWhatsAppMedia(msg.mediaId!, WA_ACCESS_TOKEN);
      audioData = result.data;
      mimeType = result.mimeType || "audio/ogg";
    } catch {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
        msg.messageId,
      );
      return;
    }
    const base64Audio = safeBytesToBase64(audioData);
    userReply = [
      {
        text: "Pahami audio berikut berisi instruksi user untuk mengedit atau menghapus transaksi.",
      },
      {
        inlineData: { data: base64Audio, mimeType },
      },
    ];
  } else {
    userReply = msg.text ?? "";
  }

  const [cats, wallets] = await Promise.all([
    getCategories(db, userId),
    getWallets(db, userId),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Minta Gemini tafsirkan instruksi koreksi jika bukan hapus langsung
  const replyText = (typeof userReply === "string" ? userReply : msg.text ?? "").trim().toLowerCase();
  const isDirectDelete = /^(batalkan|batal|hapus|undo|ga jadi|gajadi|cancel|batalin|delete|del|back)$/i.test(replyText) ||
    /^(tolong|mohon)?\s*(hapus|batalkan|cancel|undo|gajadi|ga jadi)\s*(transaksi|aja|catatan|terakhir|yang tadi)?$/i.test(replyText);

  let instruction;
  if (isDirectDelete) {
    instruction = { action: "delete" as const };
  } else {
    try {
      instruction = await parseEditInstruction(
        apiKeys,
        userReply,
        txData,
        expenseCats,
        incomeCats,
        wallets.map((wallet) => wallet.name),
      );
    } catch {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        "Gagal memproses instruksi, coba lagi ya.",
        msg.messageId,
      );
      return;
    }
  }

  if (instruction.action === "unclear") {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik'}`,
      msg.messageId,
    );
    return;
  }

  if (instruction.action === "delete") {
    // Sync deletion to user_settings.deleted_ids in database
    await recordDeletionInDb(db, transactionId, userId);

    // ── VERSI 2: Revert checklist / debt payments ──
    if (txData.source === "whatsapp") {
      // 1. Revert Checklist
      const { data: recurringItems } = await db
        .from("recurring_items")
        .select("*")
        .eq("user_id", userId);

      if (recurringItems) {
        const matchedRec = recurringItems.find(
          (r) => r.name === txData.note && r.category_id === txData.category_id
        );
        if (matchedRec) {
          await db
            .from("recurring_items")
            .update({
              last_confirmed_date: null,
              updated_at: new Date().toISOString()
            })
            .eq("id", matchedRec.id);
        }
      }

      // 2. Revert Debt
      if (txData.category === "Utang Piutang") {
        const note = txData.note ?? "";
        // note format: "Cicilan utang Budi: ..." atau "Pelunasan utang Budi: ..."
        // Kita match nama orang setelah kata 'utang' atau 'piutang'
        const personMatch = note.match(/(?:utang|piutang)\s+([A-Za-z0-9_]+)/i);
        if (personMatch) {
          const personName = personMatch[1];
          const { data: debtEntries } = await db
            .from("debt_entries")
            .select("*")
            .eq("user_id", userId)
            .eq("person_name", personName);

          if (debtEntries && debtEntries.length > 0) {
            // Cek jika ini pelunasan (mencari debt entry dengan status 'lunas' dan payoff_date set)
            const payoffEntry = debtEntries.find(
              (d) => d.status === "lunas" && d.payoff_date === txData.date
            );

            if (payoffEntry) {
              // Kembalikan ke active
              await db
                .from("debt_entries")
                .update({
                  status: "active",
                  payoff_wallet_id: null,
                  payoff_date: null,
                  updated_at: new Date().toISOString()
                })
                .eq("id", payoffEntry.id);

              // Cari & hapus reverse debt (overpayment) jika ada
              const reverseType = payoffEntry.type === "i_owe" ? "owed_to_me" : "i_owe";
              const { data: reverseEntry } = await db
                .from("debt_entries")
                .select("id")
                .eq("user_id", userId)
                .eq("person_name", personName)
                .eq("type", reverseType)
                .eq("status", "active")
                .eq("date", txData.date)
                .like("note", "Kelebihan pembayaran%")
                .maybeSingle();

              if (reverseEntry) {
                await db.from("debt_entries").delete().eq("id", reverseEntry.id).eq("user_id", userId);
              }
            } else {
              // Ini cicilan. Kembalikan nominalnya ke entri active pertama
              const activeEntry = debtEntries.find(
                (d) => d.status === "active" || d.status === "belum"
              );
              if (activeEntry) {
                const newAmt = (Number(activeEntry.amount) || 0) + (Number(txData.amount) || 0);
                await db
                  .from("debt_entries")
                  .update({
                    amount: newAmt,
                    updated_at: new Date().toISOString()
                  })
                  .eq("id", activeEntry.id);
              }
            }
          }
        }
      }
    }

    await db.from("wa_message_transactions").delete().eq("transaction_id", transactionId).eq("user_id", userId);
    await db.from("transactions").delete().eq("id", transactionId).eq("user_id", userId);

    // Recalculate balances murni from database transactions!
    await recalculateDbWalletBalances(db, userId);

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Transaksi dihapus:\n"${txData.note}" ${formatRupiah(txData.amount)} (${formatTanggalID(txData.date)})`,
      msg.messageId,
    );
    return;
  }

  // action === "edit"
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const targetWalletId = instruction.wallet
    ? findWalletId(instruction.wallet, wallets)
    : txData.wallet_id;

  if (instruction.amount != null && instruction.amount > 0) {
    updates.amount = instruction.amount;
  }

  if (instruction.category) {
    const type = txData.type as "expense" | "income";
    const catId = matchCategoryId(instruction.category, type, cats);
    const catName =
      cats.find((c) => c.id === catId)?.name ?? instruction.category;
    updates.category_id = catId;
    updates.category = catName;
  }

  if (instruction.note) {
    updates.note = instruction.note.slice(0, 80);
  }

  if (instruction.wallet && targetWalletId) {
    updates.wallet_id = targetWalletId;
  } else if (instruction.wallet) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Dompetnya belum ketemu. Sebutkan nama dompet yang ada ya.",
      msg.messageId,
    );
    return;
  }

  await db.from("transactions").update(updates).eq("id", transactionId).eq("user_id", userId);

  // Recalculate balances murni dari transaksi database!
  await recalculateDbWalletBalances(db, userId);

  // Refresh dan kirim konfirmasi
  const { data: updatedTx } = await db
    .from("transactions")
    .select("*")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .single();

  if (updatedTx) {
    const updatedWallets = await getWallets(db, userId);
    await sendAndMapTx(
      db,
      updatedTx as unknown as TransactionRow,
      updatedWallets,
      waChatId,
      msg.messageId,
      true,
      userId,
    );
  }
}

// ============================================================
// HANDLER: Reply ke pertanyaan nominal pending
// ============================================================

function parseNominalReply(replyText: string): number | null {
  const normalized = replyText.toLowerCase().trim();
  const slang: Record<string, number> = {
    seceng: 1000,
    goceng: 5000,
    noceng: 9000,
    ceban: 10000,
    goban: 50000,
    gocap: 50000,
  };
  for (const [word, amount] of Object.entries(slang))
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return amount;
  const amountMatch = normalized.match(/[\d.,]+/);
  if (!amountMatch) return null;
  const raw = amountMatch[0];
  const numberValue = Number(
    raw.replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."),
  );
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  if (
    /\b(rb|ribu|k)\b/i.test(normalized) ||
    /\d(?:rb|ribu|k)\b/i.test(normalized)
  )
    return Math.round(numberValue * 1000);
  if (/\b(jt|juta)\b/i.test(normalized) || /\d(?:jt|juta)\b/i.test(normalized))
    return Math.round(numberValue * 1_000_000);
  return Math.round(numberValue < 1000 ? numberValue * 1000 : numberValue);
}

export async function handlePendingNominalMessage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  userId: string,
): Promise<boolean> {
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("user_id", userId)
    .eq("wa_chat_id", msg.from)
    .gt("created_at", fifteenMinsAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pending?.id) return false;

  const pendingData =
    typeof pending.pending_data === "string"
      ? JSON.parse(pending.pending_data)
      : pending.pending_data;

  const userText = (msg.text ?? "").trim();
  if (!userText) return false;

  const cats = await getCategories(db, userId);
  const expenseCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);

  // Parse user reply using AI to update fields (amount, note, category)
  const result = await parseClarificationReply(
    apiKeys,
    userText,
    {
      type: pendingData.type,
      amount: pendingData.amount,
      note: pendingData.note,
      category: pendingData.category,
    },
    expenseCats,
    incomeCats,
  );

  pendingData.amount = result.amount;
  pendingData.note = result.note;
  pendingData.category = result.category;
  pendingData.category_id = matchCategoryId(result.category, pendingData.type, cats);

  if (pendingData.amount === 0) {
    const rawAmt = parseNominalReply(userText);
    if (rawAmt && rawAmt > 0) {
      pendingData.amount = rawAmt;
    } else {
      return false; // Still no amount, don't consume
    }
  }

  const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
  const isNoteGeneric = !pendingData.note || genericNotes.includes(pendingData.note.toLowerCase().trim());

  if (isNoteGeneric) {
    pendingData.note = "";
    await db
      .from("wa_pending_transactions")
      .update({
        pending_data: JSON.stringify(pendingData),
      })
      .eq("id", pending.id)
      .eq("user_id", userId);

    let questionText = "";
    if (pendingData.isFromMedia) {
      questionText = `Gagal membaca media yang kamu kirim, ${formatRupiah(pendingData.amount)} ini buat bayar apa?`;
    } else {
      questionText = await generateClarificationQuestion(apiKeys, {
        type: "note",
        amount: pendingData.amount,
      });
    }

    const questionMsg = await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      questionText,
      msg.messageId,
    );
    if (questionMsg) {
      await db
        .from("wa_pending_transactions")
        .update({ wa_question_message_id: questionMsg })
        .eq("id", pending.id)
        .eq("user_id", userId);
    }
    return true;
  }

  const wallets = await getWallets(db, userId);
  const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets, userId);
  const updatedWallets = wallets.map((w) =>
    w.id === updatedWallet.id ? updatedWallet : w,
  );
  await sendAndMapTx(db, savedTx, updatedWallets, msg.from, msg.messageId, false, userId);
  await db.from("wa_pending_transactions").delete().eq("id", pending.id).eq("user_id", userId);
  return true;
}

async function completePendingNominal(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  pendingId: string,
  amount: number,
  userId: string,
): Promise<void> {
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("id", pendingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!pending) return;

  const pendingData =
    typeof pending.pending_data === "string"
      ? JSON.parse(pending.pending_data)
      : pending.pending_data;
  pendingData.amount = amount;

  const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
  const isNoteGeneric = !pendingData.note || genericNotes.includes(pendingData.note.toLowerCase().trim());
  if (isNoteGeneric) {
    pendingData.note = "";
    await db
      .from("wa_pending_transactions")
      .update({
        pending_data: JSON.stringify(pendingData),
      })
      .eq("id", pendingId)
      .eq("user_id", userId);

    let questionText = "";
    if (pendingData.isFromMedia) {
      questionText = `Gagal membaca media yang kamu kirim, ${formatRupiah(amount)} ini buat bayar apa?`;
    } else {
      questionText = await generateClarificationQuestion(apiKeys, {
        type: "note",
        amount,
      });
    }

    const questionMsg = await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      questionText,
      msg.messageId,
    );
    if (questionMsg) {
      await db
        .from("wa_pending_transactions")
        .update({ wa_question_message_id: questionMsg })
        .eq("id", pendingId)
        .eq("user_id", userId);
    }
    return;
  }

  const wallets = await getWallets(db, userId);
  const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets, userId);
  const updatedWallets = wallets.map((w) =>
    w.id === updatedWallet.id ? updatedWallet : w,
  );
  await sendAndMapTx(db, savedTx, updatedWallets, msg.from, msg.messageId, false, userId);
  await db.from("wa_pending_transactions").delete().eq("id", pendingId).eq("user_id", userId);
}

export async function handlePendingNominalReply(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  pendingId: string,
  userId: string,
): Promise<void> {
  const waChatId = msg.from;
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("id", pendingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!pending) return;

  const pendingData =
    typeof pending.pending_data === "string"
      ? JSON.parse(pending.pending_data)
      : pending.pending_data;

  const userText = (msg.text ?? "").trim();
  if (!userText) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Jawaban kosong, silakan ketik keterangan atau nilai nominalnya.",
      msg.messageId,
    );
    return;
  }

  const cats = await getCategories(db, userId);
  const expenseCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);

  // Parse user reply using AI to update fields (amount, note, category)
  const result = await parseClarificationReply(
    apiKeys,
    userText,
    {
      type: pendingData.type,
      amount: pendingData.amount,
      note: pendingData.note,
      category: pendingData.category,
    },
    expenseCats,
    incomeCats,
  );

  pendingData.amount = result.amount;
  pendingData.note = result.note;
  pendingData.category = result.category;
  pendingData.category_id = matchCategoryId(result.category, pendingData.type, cats);

  if (pendingData.amount === 0) {
    const amount = parseNominalReply(userText);
    if (!amount) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        "Tidak ketemu angka nominalnya, coba tulis lagi.",
        msg.messageId,
      );
      return;
    }
    pendingData.amount = amount;
  }

  const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
  const isNoteGeneric = !pendingData.note || genericNotes.includes(pendingData.note.toLowerCase().trim());

  if (isNoteGeneric) {
    pendingData.note = "";
    await db
      .from("wa_pending_transactions")
      .update({
        pending_data: JSON.stringify(pendingData),
      })
      .eq("id", pendingId)
      .eq("user_id", userId);

    let questionText = "";
    if (pendingData.isFromMedia) {
      questionText = `Gagal membaca media yang kamu kirim, ${formatRupiah(pendingData.amount)} ini buat bayar apa?`;
    } else {
      questionText = await generateClarificationQuestion(apiKeys, {
        type: "note",
        amount: pendingData.amount,
      });
    }

    const questionMsg = await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      questionText,
      msg.messageId,
    );
    if (questionMsg) {
      await db
        .from("wa_pending_transactions")
        .update({ wa_question_message_id: questionMsg })
        .eq("id", pendingId)
        .eq("user_id", userId);
    }
    return;
  }

  const wallets = await getWallets(db, userId);
  const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets, userId);
  const updatedWallets = wallets.map((w) =>
    w.id === updatedWallet.id ? updatedWallet : w,
  );
  await sendAndMapTx(db, savedTx, updatedWallets, waChatId, msg.messageId, false, userId);
  await db.from("wa_pending_transactions").delete().eq("id", pendingId).eq("user_id", userId);
}

// ============================================================
// HANDLER: Cek saldo
// ============================================================

export async function handleCekSaldo(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  userId: string,
): Promise<void> {
  const wallets = await getWallets(db, userId);
  if (!wallets.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Belum ada data dompet.",
      replyToMsgId,
    );
    return;
  }

  // Sort: Primary wallet first, then by sort_order ASC
  const sorted = wallets.slice().sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });

  let msg = "";
  for (const w of sorted) {
    if (w.is_primary) {
      msg += `*${w.name}: ${formatRupiah(w.balance ?? 0)}*\n`;
    } else {
      msg += `${w.name}: ${formatRupiah(w.balance ?? 0)}\n`;
    }
  }

  const total = wallets.reduce((s, w) => s + (w.balance ?? 0), 0);
  msg += `\nTotal Saldo: ${formatRupiah(total)}`;

  await sendUserResponse(
    db,
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    userId,
    waChatId,
    msg.trim(),
    replyToMsgId,
  );
}

// ============================================================
// HANDLER: Hapus transaksi terakhir (via WA)
// ============================================================

async function handleHapusTerakhir(
  db: SupabaseClient,
  waChatId: string,
  replyToMsgId: string,
  userId: string,
): Promise<void> {
  const { data: txs } = await db
    .from("transactions")
    .select("*")
    .eq("user_id", userId)
    .eq("source", "whatsapp")
    .order("updated_at", { ascending: false })
    .limit(1);

  const tx = txs?.[0];
  if (!tx) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      "Tidak ada transaksi WA terakhir yang bisa dihapus.",
      replyToMsgId,
    );
    return;
  }

  // Sync deletion to user_settings.deleted_ids in database
  await recordDeletionInDb(db, tx.id, userId);

  await db.from("wa_message_transactions").delete().eq("transaction_id", tx.id).eq("user_id", userId);
  await db.from("transactions").delete().eq("id", tx.id).eq("user_id", userId);

  // Recalculate balances murni from database transactions!
  await recalculateDbWalletBalances(db, userId);

  await sendWhatsAppMessage(
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    waChatId,
    `Transaksi terakhir dihapus:\n"${tx.note}" ${formatRupiah(tx.amount)} (${formatTanggalID(tx.date)})`,
    replyToMsgId,
  );
}

export async function handleWebChatImage(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  imageBlobBase64: string,
  imageMimeType: string,
  userId: string,
): Promise<void> {
  const today = getTodayStr();
  const [cats, wallets] = await Promise.all([
    getCategories(db, userId),
    getWallets(db, userId),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Web chat mengirim voice note lewat field "image" yang sama (browser cuma tahu
  // "file"), jadi audio harus dideteksi lewat mimeType di sini. Perlakuan disamakan
  // persis dengan voice note di WA bot: transkrip dulu, cek query ("cek saldo",
  // pertanyaan pakai "?") SEBELUM dianggap transaksi.
  const isAudio = imageMimeType.startsWith("audio/");
  let effectiveText = msg.text || "";

  if (isAudio) {
    let transcript = "";
    try {
      transcript = await transcribeAudioToText(apiKeys, imageBlobBase64, imageMimeType);
    } catch (e) {
      console.error("Gagal transkrip audio web chat:", e);
    }
    const combined = [msg.text, transcript].filter(Boolean).join(" ").trim();
    if (combined) {
      const handled = await handleAudioTranscriptAsQueryIfApplicable(
        db,
        apiKeys,
        combined,
        msg.from,
        msg.messageId,
        userId,
      );
      if (handled) return;
    }
    effectiveText = combined;
  }

  const parts: GeminiPart[] = isAudio
    ? [{ text: `TEKS_BEBAS_DARI_USER: ${effectiveText}` }]
    : [{ inlineData: { data: imageBlobBase64, mimeType: imageMimeType } }];
  if (!isAudio && msg.text) {
    parts.push({ text: `TEKS_BEBAS_DARI_USER: ${msg.text}` });
  }

  let items: ParsedTransaction[];
  try {
    items = await parseTransactions(
      apiKeys,
      parts,
      expenseCats,
      incomeCats,
      today,
    );
  } catch (e) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      msg.from,
      "Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  const mentionedWalletName = findMentionedWallet(effectiveText, wallets);
  await processParsedItems(db, apiKeys, items, cats, wallets, msg.from, msg.messageId, mentionedWalletName, true, userId);
}

// ============================================================
// HELPER EXPORT: Cek apakah sender adalah pemilik produk
// ============================================================

export function isOwner(from: string): boolean {
  // Normalkan format nomor: hapus + dan leading 0
  const normalize = (n: string) => n.replace(/\D/g, "").replace(/^0/, "62");
  return normalize(from) === normalize(OWNER_PHONE);
}

export { BATCH_WINDOW_MS, PHONE_NUMBER_ID, WA_ACCESS_TOKEN, OWNER_PHONE };
