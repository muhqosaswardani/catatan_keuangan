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
  matchHistoryAmountWithAi,
} from "./gemini.ts";
import { sendWhatsAppMessage, downloadWhatsAppMedia, safeBytesToBase64 } from "./whatsapp.ts";

// ============================================================
// KONFIGURASI TETAP
// ============================================================

const ACCESS_CODE = Deno.env.get("WA_ACCESS_CODE") ?? "";
const DEFAULT_WALLET_ID = Deno.env.get("WA_DEFAULT_WALLET_ID") ?? "";
const OWNER_PHONE = Deno.env.get("WA_OWNER_PHONE") ?? "6281226964679"; // 081226964679 → E.164
const PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;

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

interface WalletRow {
  id: string;
  name: string;
  balance: number;
}

interface CategoryRow {
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

async function getCategories(db: SupabaseClient): Promise<CategoryRow[]> {
  const { data } = await db
    .from("categories")
    .select("id, name, type")
    .eq("access_code", ACCESS_CODE);
  return (data ?? []) as CategoryRow[];
}

async function getWallets(db: SupabaseClient): Promise<WalletRow[]> {
  const { data } = await db
    .from("wallets")
    .select("id, name, balance")
    .eq("access_code", ACCESS_CODE);
  return (data ?? []) as WalletRow[];
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

function matchWalletId(
  mentionedName: string | undefined,
  wallets: WalletRow[],
): string {
  if (!mentionedName) return DEFAULT_WALLET_ID;
  // Cek apakah ada dompet yang namanya mengandung kata dari mention
  const lower = mentionedName.toLowerCase();
  const found = wallets.find(
    (w) =>
      w.name.toLowerCase().includes(lower) ||
      lower.includes(w.name.toLowerCase()),
  );
  return found?.id ?? DEFAULT_WALLET_ID;
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
): Promise<number | null> {
  const { data: txs } = await db
    .from("transactions")
    .select("amount, note, date, category_id")
    .eq("access_code", ACCESS_CODE)
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
): Promise<void> {
  if (!id) return;
  const { data: settings } = await db
    .from("user_settings")
    .select("deleted_ids")
    .eq("access_code", ACCESS_CODE)
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
      .eq("access_code", ACCESS_CODE);
  }
}

async function recalculateDbWalletBalances(
  db: SupabaseClient,
  accessCode: string,
): Promise<void> {
  const { data: wallets } = await db
    .from("wallets")
    .select("*")
    .eq("access_code", accessCode);
  const { data: transactions } = await db
    .from("transactions")
    .select("*")
    .eq("access_code", accessCode);

  if (!wallets || !transactions) return;

  const sums: Record<string, number> = {};
  for (const w of wallets) {
    sums[w.id] = 0;
  }

  const todayStr = getTodayStr();

  for (const t of transactions) {
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

  const { data: settings } = await db
    .from("user_settings")
    .select("nav_config")
    .eq("access_code", accessCode)
    .maybeSingle();

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
      .eq("access_code", accessCode);
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
): Promise<{ savedTx: TransactionRow; updatedWallet: WalletRow }> {
  const id = tx.id ?? `wa_tx_${uid()}`;
  const row: TransactionRow = { ...tx, id } as TransactionRow;

  const { error: txErr } = await db.from("transactions").insert({
    id,
    access_code: ACCESS_CODE,
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
  await recalculateDbWalletBalances(db, ACCESS_CODE);

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
): Promise<void> {
  await db.from("wa_message_transactions").insert({
    wa_message_id: waMessageId,
    transaction_id: transactionId,
    access_code: ACCESS_CODE,
  });
}

// ============================================================
// PROSES: Kirim balasan konfirmasi per transaksi
// ============================================================

async function sendAndMapTx(
  db: SupabaseClient,
  tx: TransactionRow,
  wallets: WalletRow[],
  replyToMsgId?: string,
  isUpdated = false,
): Promise<void> {
  const wallet = wallets.find((w) => w.id === tx.wallet_id) ?? wallets[0];
  const bubble = formatConfirmBubble(
    tx,
    wallet.name,
    wallet.balance,
    isUpdated,
  );

  const sentMsgId = await sendWhatsAppMessage(
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    OWNER_PHONE,
    bubble,
    replyToMsgId,
  );

  if (sentMsgId) {
    await saveMapping(db, sentMsgId, tx.id);
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
  incomingMsgId: string,
  mentionedWalletName?: string,
  isFromMedia = false,
): Promise<void> {
  const today = getTodayStr();

  // Scaling proporsional untuk groupId
  const rawRows = items.map((it, idx) => {
    const type: "expense" | "income" =
      it.type === "income" ? "income" : "expense";
    const catId = matchCategoryId(it.category, type, cats);
    const catName =
      cats.find((c) => c.id === catId)?.name ?? it.category ?? "Lainnya";
    const walletId = matchWalletId(it.wallet || mentionedWalletName, wallets);
    return {
      _idx: idx,
      _groupId: it.groupId ?? null,
      _groupTotal: it.groupTotal ?? null,
      id: `wa_tx_${uid()}`,
      wallet_id: walletId,
      category_id: catId,
      category: catName,
      type,
      amount: Math.max(0, Math.round(Number(it.amount) || 0)),
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date ?? "") ? it.date! : today,
      note: (it.note ?? "").slice(0, 80),
      source: "whatsapp",
      isFromMedia,
    };
  });

  // Scaling proporsional
  applyGroupScaling(rawRows as unknown as TransactionRow[]);

  for (const row of rawRows) {
    const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
    const isNoteGeneric = !row.note || genericNotes.includes(row.note.toLowerCase().trim());

    if (row.amount === 0) {
      // Coba history fallback (hanya jika note tidak generic)
      let histAmt = null;
      if (!isNoteGeneric) {
        histAmt = await findHistoryAmount(
          db,
          apiKeys,
          row.note,
          row.category_id,
          row.type,
        );
      }

      if (histAmt && histAmt > 0) {
        row.amount = histAmt;
      } else {
        // Tahan di pending, tanya nominal
        const pendingId = `pend_${uid()}`;
        await db.from("wa_pending_transactions").insert({
          id: pendingId,
          access_code: ACCESS_CODE,
          wa_chat_id: OWNER_PHONE,
          pending_data: JSON.stringify(row),
        });
        const questionText = await generateClarificationQuestion(apiKeys, {
          type: "amount",
          note: isNoteGeneric ? undefined : row.note,
        });

        const questionMsg = await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          OWNER_PHONE,
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
      const pendingId = `pend_${uid()}`;
      row.note = ""; // Reset note agar kosong saat ditanya
      await db.from("wa_pending_transactions").insert({
        id: pendingId,
        access_code: ACCESS_CODE,
        wa_chat_id: OWNER_PHONE,
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
        OWNER_PHONE,
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
    );

    // Kirim konfirmasi bubble
    const updatedWallets = wallets.map((w) =>
      w.id === updatedWallet.id ? updatedWallet : w,
    );
    await sendAndMapTx(db, savedTx, updatedWallets, incomingMsgId);

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
): Promise<void> {
  const text = msg.text ?? "";
  const today = getTodayStr();

  // Cek perintah khusus
  if (/^(cek saldo|saldo|berapa saldo|total saldo)/i.test(text.trim())) {
    await handleCekSaldo(db, msg.messageId);
    return;
  }

  const isCancelCommand = /^(batalkan|batal|hapus transaksi terakhir|hapus terakhir|hapus|undo|ga jadi|gajadi|cancel|batalin|delete|del|back)$/i.test(text.trim()) ||
    /^(tolong|mohon)?\s*(hapus|batalkan|cancel|undo|gajadi|ga jadi)\s*(transaksi|aja|catatan|terakhir|yang tadi)?$/i.test(text.trim());

  if (isCancelCommand) {
    await handleHapusTerakhir(db, msg.messageId);
    return;
  }

  // PRD 5.1a: jawaban nominal boleh dikirim sebagai pesan baru, bukan hanya reply.
  if (await handlePendingNominalMessage(db, apiKeys, msg)) return;

  const [cats, wallets] = await Promise.all([
    getCategories(db),
    getWallets(db),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Coba parse sebagai transaksi
  const annotatedText = annotateSlangNominalForAi(text);
  const parts: GeminiPart[] = [{ text: `TEKS_BEBAS_DARI_USER: ${annotatedText}` }];
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
      OWNER_PHONE,
      "Maaf, lagi ada gangguan baca pesannya, coba lagi ya.",
      msg.messageId,
    );
    return;
  }

  if (!items.length) {
    // Pesan bukan transaksi → respons AI natural
    try {
      const reply = await generateNaturalResponse(apiKeys, text);
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        OWNER_PHONE,
        reply,
        msg.messageId,
      );
    } catch {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        OWNER_PHONE,
        "Halo! Ada yang bisa dibantu?",
        msg.messageId,
      );
    }
    return;
  }

  const mentionedWalletName = findMentionedWallet(text, wallets);
  await processParsedItems(db, apiKeys, items, cats, wallets, msg.messageId, mentionedWalletName, false);
}

// ============================================================
// HANDLER: Foto (single atau dari batch)
// ============================================================

export async function handleMediaBatch(
  db: SupabaseClient,
  apiKeys: string[],
  mediaItems: QueuedMediaItem[],
  firstMsgId: string,
): Promise<void> {
  const today = getTodayStr();
  const [cats, wallets] = await Promise.all([
    getCategories(db),
    getWallets(db),
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

  const parts: GeminiPart[] = [];

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

  if (!parts.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
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
  } catch {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      firstMsgId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.",
      firstMsgId,
    );
    return;
  }

  const isFromMedia = mediaItems.some((m) => m.kind === "image");
  const mentionedWalletName = findMentionedWallet(captions, wallets);
  await processParsedItems(db, apiKeys, items, cats, wallets, firstMsgId, mentionedWalletName, isFromMedia);
}

// Ambil dan claim media yang sudah melewati jeda hening. Claim kondisional
// mencegah dua invocation yang bangun bersamaan memproses media yang sama.
export async function processQueuedMediaBatch(
  db: SupabaseClient,
  apiKeys: string[],
  chatId: string,
): Promise<void> {
  const quietBefore = new Date(Date.now() - BATCH_WINDOW_MS).toISOString();
  // Debounce: bila masih ada media yang baru masuk, timer dari media terakhir
  // yang akan memproses semuanya sekaligus.
  const { data: newest } = await db
    .from("wa_media_queue")
    .select("received_at")
    .eq("access_code", ACCESS_CODE)
    .eq("wa_chat_id", chatId)
    .is("processed_at", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!newest || newest.received_at > quietBefore) return;

  const { data: candidates, error } = await db
    .from("wa_media_queue")
    .select("wa_message_id, media_id, mime_type, media_kind, caption")
    .eq("access_code", ACCESS_CODE)
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
): Promise<void> {
  const today = getTodayStr();
  const [cats, wallets] = await Promise.all([
    getCategories(db),
    getWallets(db),
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
      OWNER_PHONE,
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
      OWNER_PHONE,
      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Tidak ketemu info transaksi dari media ini. Coba ketik manual atau kirim pesan suara.",
      msg.messageId,
    );
    return;
  }

  await processParsedItems(db, apiKeys, items, cats, wallets, msg.messageId, undefined, false);
}

// ============================================================
// HANDLER: Reply ke bubble transaksi (edit/delete)
// ============================================================

export async function handleReplyToTransaction(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  transactionId: string,
): Promise<void> {
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
        .maybeSingle();

      if (debtData) {
        await db.from("debt_entries").delete().eq("id", transactionId);
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          OWNER_PHONE,
          `Catatan utang ${debtData.person_name} sebesar ${formatRupiah(debtData.amount)} berhasil dihapus.`,
          msg.messageId
        );
      } else {
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          OWNER_PHONE,
          `Catatan utang tidak ditemukan atau sudah dihapus.`,
          msg.messageId
        );
      }
      return;
    } else {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        OWNER_PHONE,
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
    .eq("access_code", ACCESS_CODE)
    .single();

  if (error || !txData) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
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
        OWNER_PHONE,
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
    getCategories(db),
    getWallets(db),
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
        OWNER_PHONE,
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
      OWNER_PHONE,
      `Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik'}`,
      msg.messageId,
    );
    return;
  }

  if (instruction.action === "delete") {
    // Sync deletion to user_settings.deleted_ids in database
    await recordDeletionInDb(db, transactionId);

    // ── VERSI 2: Revert checklist / debt payments ──
    if (txData.source === "whatsapp") {
      // 1. Revert Checklist
      const { data: recurringItems } = await db
        .from("recurring_items")
        .select("*")
        .eq("access_code", ACCESS_CODE);

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
            .eq("access_code", ACCESS_CODE)
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
                .eq("access_code", ACCESS_CODE)
                .eq("person_name", personName)
                .eq("type", reverseType)
                .eq("status", "active")
                .eq("date", txData.date)
                .like("note", "Kelebihan pembayaran%")
                .maybeSingle();

              if (reverseEntry) {
                await db.from("debt_entries").delete().eq("id", reverseEntry.id);
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

    await db.from("transactions").delete().eq("id", transactionId);

    // Recalculate balances murni from database transactions!
    await recalculateDbWalletBalances(db, ACCESS_CODE);

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
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
      OWNER_PHONE,
      "Dompetnya belum ketemu. Sebutkan nama dompet yang ada ya.",
      msg.messageId,
    );
    return;
  }

  await db.from("transactions").update(updates).eq("id", transactionId);

  // Recalculate balances murni dari transaksi database!
  await recalculateDbWalletBalances(db, ACCESS_CODE);

  // Refresh dan kirim konfirmasi
  const { data: updatedTx } = await db
    .from("transactions")
    .select("*")
    .eq("id", transactionId)
    .single();

  if (updatedTx) {
    const updatedWallets = await getWallets(db);
    await sendAndMapTx(
      db,
      updatedTx as unknown as TransactionRow,
      updatedWallets,
      msg.messageId,
      true,
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
): Promise<boolean> {
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("access_code", ACCESS_CODE)
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

  if (pendingData.amount === 0) {
    const amount = parseNominalReply(msg.text ?? "");
    if (!amount) return false;
    await completePendingNominal(db, apiKeys, msg, pending.id, amount);
    return true;
  } else {
    const rawNote = (msg.text ?? "").trim().slice(0, 80);
    const genericNotes = ["pengeluaran", "pemasukan", "transaksi", "lainnya", ""];
    if (!rawNote || genericNotes.includes(rawNote.toLowerCase())) return false;
    
    const cleanedNote = await cleanClarifiedNote(apiKeys, rawNote);
    pendingData.note = cleanedNote;

    const cats = await getCategories(db);
    const expenseCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
    const incomeCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
    const newCatName = await reclassifyCategory(
      apiKeys,
      cleanedNote,
      pendingData.type,
      expenseCats,
      incomeCats,
    );
    pendingData.category = newCatName;
    pendingData.category_id = matchCategoryId(newCatName, pendingData.type, cats);

    const wallets = await getWallets(db);
    const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets);
    const updatedWallets = wallets.map((w) =>
      w.id === updatedWallet.id ? updatedWallet : w,
    );
    await sendAndMapTx(db, savedTx, updatedWallets, msg.messageId);
    await db.from("wa_pending_transactions").delete().eq("id", pending.id);
    return true;
  }
}

async function completePendingNominal(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  pendingId: string,
  amount: number,
): Promise<void> {
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("id", pendingId)
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
      .eq("id", pendingId);

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
      OWNER_PHONE,
      questionText,
      msg.messageId,
    );
    if (questionMsg) {
      await db
        .from("wa_pending_transactions")
        .update({ wa_question_message_id: questionMsg })
        .eq("id", pendingId);
    }
    return;
  }

  const wallets = await getWallets(db);
  const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets);
  const updatedWallets = wallets.map((w) =>
    w.id === updatedWallet.id ? updatedWallet : w,
  );
  await sendAndMapTx(db, savedTx, updatedWallets, msg.messageId);
  await db.from("wa_pending_transactions").delete().eq("id", pendingId);
}

export async function handlePendingNominalReply(
  db: SupabaseClient,
  apiKeys: string[],
  msg: IncomingMessage,
  pendingId: string,
): Promise<void> {
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle();

  if (!pending) return;

  const pendingData =
    typeof pending.pending_data === "string"
      ? JSON.parse(pending.pending_data)
      : pending.pending_data;

  if (pendingData.amount === 0) {
    const amount = parseNominalReply(msg.text ?? "");
    if (!amount) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        OWNER_PHONE,
        "Tidak ketemu angka nominalnya, coba tulis lagi.",
        msg.messageId,
      );
      return;
    }
    await completePendingNominal(db, apiKeys, msg, pendingId, amount);
  } else {
    const rawNote = (msg.text ?? "").trim().slice(0, 80);
    if (!rawNote) {
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        OWNER_PHONE,
        "Keterangannya kosong, coba ketik barang atau jasa yang jelas ya",
        msg.messageId,
      );
      return;
    }

    const cleanedNote = await cleanClarifiedNote(apiKeys, rawNote);
    pendingData.note = cleanedNote;

    const cats = await getCategories(db);
    const expenseCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
    const incomeCats = cats.filter((c) => c.type === pendingData.type).map((c) => c.name);
    const newCatName = await reclassifyCategory(
      apiKeys,
      cleanedNote,
      pendingData.type,
      expenseCats,
      incomeCats,
    );
    pendingData.category = newCatName;
    pendingData.category_id = matchCategoryId(newCatName, pendingData.type, cats);

    const wallets = await getWallets(db);
    const { savedTx, updatedWallet } = await saveTx(db, pendingData, wallets);
    const updatedWallets = wallets.map((w) =>
      w.id === updatedWallet.id ? updatedWallet : w,
    );
    await sendAndMapTx(db, savedTx, updatedWallets, msg.messageId);
    await db.from("wa_pending_transactions").delete().eq("id", pendingId);
  }
}

// ============================================================
// HANDLER: Cek saldo
// ============================================================

async function handleCekSaldo(
  db: SupabaseClient,
  replyToMsgId: string,
): Promise<void> {
  const wallets = await getWallets(db);
  if (!wallets.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Belum ada data dompet.",
      replyToMsgId,
    );
    return;
  }

  // Sort: Dompet Utama first, Dompet Tabungan second, then others
  const sorted = wallets.slice().sort((a, b) => {
    const aId = a.id.toLowerCase();
    const bId = b.id.toLowerCase();
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();

    const isAUtama = aId === "wallet_utama" || aName.includes("utama");
    const isBUtama = bId === "wallet_utama" || bName.includes("utama");
    const isATabungan = aId === "wallet_tabungan" || aName.includes("tabungan");
    const isBTabungan = bId === "wallet_tabungan" || bName.includes("tabungan");

    if (isAUtama && !isBUtama) return -1;
    if (!isAUtama && isBUtama) return 1;
    if (isATabungan && !isBTabungan) return -1;
    if (!isATabungan && isBTabungan) return 1;
    return 0;
  });

  let msg = "";
  for (const w of sorted) {
    const isUtama = w.id.toLowerCase() === "wallet_utama" || w.name.toLowerCase().includes("utama");
    if (isUtama) {
      msg += `*${w.name}: ${formatRupiah(w.balance ?? 0)}*\n`;
    } else {
      msg += `${w.name}: ${formatRupiah(w.balance ?? 0)}\n`;
    }
  }

  const total = wallets.reduce((s, w) => s + (w.balance ?? 0), 0);
  msg += `\nTotal Saldo: ${formatRupiah(total)}`;

  await sendWhatsAppMessage(
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    OWNER_PHONE,
    msg.trim(),
    replyToMsgId,
  );
}

// ============================================================
// HANDLER: Hapus transaksi terakhir (via WA)
// ============================================================

async function handleHapusTerakhir(
  db: SupabaseClient,
  replyToMsgId: string,
): Promise<void> {
  const { data: txs } = await db
    .from("transactions")
    .select("*")
    .eq("access_code", ACCESS_CODE)
    .eq("source", "whatsapp")
    .order("updated_at", { ascending: false })
    .limit(1);

  const tx = txs?.[0];
  if (!tx) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Tidak ada transaksi WA terakhir yang bisa dihapus.",
      replyToMsgId,
    );
    return;
  }

  // Sync deletion to user_settings.deleted_ids in database
  await recordDeletionInDb(db, tx.id);

  await db.from("transactions").delete().eq("id", tx.id);

  // Recalculate balances murni from database transactions!
  await recalculateDbWalletBalances(db, ACCESS_CODE);

  await sendWhatsAppMessage(
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    OWNER_PHONE,
    `Transaksi terakhir dihapus:\n"${tx.note}" ${formatRupiah(tx.amount)} (${formatTanggalID(tx.date)})`,
    replyToMsgId,
  );
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
