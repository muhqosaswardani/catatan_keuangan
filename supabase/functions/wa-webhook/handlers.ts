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
} from "./gemini.ts";
import { sendWhatsAppMessage, downloadWhatsAppMedia } from "./whatsapp.ts";

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
  note: string,
  categoryId: string,
  type: "expense" | "income",
): Promise<number | null> {
  const { data: txs } = await db
    .from("transactions")
    .select("amount, note, date, category_id")
    .eq("access_code", ACCESS_CODE)
    .eq("type", type)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(200);

  if (!txs?.length) return null;

  const normalize = (s: string) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const STOPWORDS = new Set([
    "masuk",
    "keluar",
    "tadi",
    "baru",
    "buat",
    "untuk",
    "dari",
    "yang",
    "sama",
    "lagi",
    "saya",
    "aku",
    "dapat",
    "terima",
    "bayar",
    "beli",
    "dan",
  ]);

  const tokenize = (s: string) =>
    normalize(s)
      .split(" ")
      .filter((w) => w && !STOPWORDS.has(w));

  const rowNorm = normalize(note);
  const rowTokens = tokenize(note);

  // 1. Exact match, kategori sama
  const sameCat = txs.filter((t) => t.category_id === categoryId);
  const exactSameCat = sameCat.find((t) => normalize(t.note) === rowNorm);
  if (exactSameCat) return exactSameCat.amount;

  // 2. Token match, kategori sama
  if (rowTokens.length) {
    let best: { t: (typeof txs)[0]; score: number } | null = null;
    for (const t of sameCat) {
      const score = tokenize(t.note).filter((tok) =>
        rowTokens.includes(tok),
      ).length;
      if (score > 0 && (!best || score > best.score)) best = { t, score };
    }
    if (best) return best.t.amount;
  }

  // 3. Exact match, lintas kategori
  const exactAll = txs.find((t) => normalize(t.note) === rowNorm);
  if (exactAll) return exactAll.amount;

  // 4. Token match, lintas kategori
  if (rowTokens.length) {
    let best: { t: (typeof txs)[0]; score: number } | null = null;
    for (const t of txs) {
      const score = tokenize(t.note).filter((tok) =>
        rowTokens.includes(tok),
      ).length;
      if (score > 0 && (!best || score > best.score)) best = { t, score };
    }
    if (best) return best.t.amount;
  }

  return null;
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
  const emoji = tx.type === "income" ? "📥" : "✓";
  const label = isUpdated ? "Transaksi diperbarui" : "Transaksi tercatat";
  const typeLabel =
    tx.type === "income"
      ? `Pemasukan: ${formatRupiah(tx.amount)}`
      : `Pengeluaran: ${formatRupiah(tx.amount)}`;

  let msg = `${emoji} ${label}\nTanggal: ${formatTanggalID(tx.date)}\n\n`;
  msg += `${typeLabel}\nKategori: ${tx.category}\n`;
  if (tx.note) msg += `Keterangan: ${tx.note}\n`;
  msg += `\nDompet: ${walletName}\nSisa dompet: ${formatRupiah(walletBalance)}`;

  return msg;
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

  // Update balance dompet
  const wallet = wallets.find((w) => w.id === row.wallet_id) ?? wallets[0];
  const delta = row.type === "income" ? row.amount : -row.amount;
  const newBalance = (wallet?.balance ?? 0) + delta;

  await db
    .from("wallets")
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq("id", wallet.id);

  return {
    savedTx: row,
    updatedWallet: { ...wallet, balance: newBalance },
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
  items: ParsedTransaction[],
  cats: CategoryRow[],
  wallets: WalletRow[],
  incomingMsgId: string,
  mentionedWalletName?: string,
): Promise<void> {
  const today = getTodayStr();

  // Scaling proporsional untuk groupId
  const rawRows = items.map((it, idx) => {
    const type: "expense" | "income" =
      it.type === "income" ? "income" : "expense";
    const catId = matchCategoryId(it.category, type, cats);
    const catName =
      cats.find((c) => c.id === catId)?.name ?? it.category ?? "Lainnya";
    const walletId = matchWalletId(mentionedWalletName, wallets);
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
    };
  });

  // Scaling proporsional
  applyGroupScaling(rawRows as unknown as TransactionRow[]);

  for (const row of rawRows) {
    if (row.amount === 0) {
      // Coba history fallback
      const histAmt = await findHistoryAmount(
        db,
        row.note,
        row.category_id,
        row.type,
      );

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

        const questionMsg = await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          OWNER_PHONE,
          `❓ Berapa nominalnya untuk "${row.note}"?\n(Balas pesan ini dengan nominalnya, mis. "25rb" atau "25000")`,
          incomingMsgId,
        );

        // Simpan question_message_id untuk bisa match reply nanti
        if (questionMsg) {
          await db
            .from("wa_pending_transactions")
            .update({ wa_question_message_id: questionMsg })
            .eq("id", pendingId);
        }
        continue;
      }
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
  if (/^(cek saldo|saldo|berapa saldo)/i.test(text)) {
    await handleCekSaldo(db, msg.messageId);
    return;
  }
  if (/^(hapus transaksi terakhir|undo|hapus terakhir)/i.test(text)) {
    await handleHapusTerakhir(db, msg.messageId);
    return;
  }

  // PRD 5.1a: jawaban nominal boleh dikirim sebagai pesan baru, bukan hanya reply.
  if (await handlePendingNominalMessage(db, msg)) return;

  const [cats, wallets] = await Promise.all([
    getCategories(db),
    getWallets(db),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Coba parse sebagai transaksi
  const parts: GeminiPart[] = [{ text: `TEKS_BEBAS_DARI_USER: ${text}` }];
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
      "⚠️ Maaf, lagi ada gangguan baca pesannya, coba lagi ya.",
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

  await processParsedItems(db, items, cats, wallets, msg.messageId);
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
      const base64 = btoa(String.fromCharCode(...data));
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
      "⚠️ Gagal baca foto/media, coba kirim ulang ya.",
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
      "⚠️ Maaf, gagal baca foto/media, coba lagi ya.",
      firstMsgId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Tidak ketemu info transaksi dari foto ini 🤔",
      firstMsgId,
    );
    return;
  }

  await processParsedItems(db, items, cats, wallets, firstMsgId);
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
      .update({ processing_started_at: null })
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
      "⚠️ Gagal download voice note, coba kirim ulang ya.",
      msg.messageId,
    );
    return;
  }

  const base64Audio = btoa(String.fromCharCode(...audioData));

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
      "⚠️ Voice note tidak berhasil diproses. Coba ketik transaksinya ya 🙏",
      msg.messageId,
    );
    return;
  }

  if (!items.length) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      "Tidak ketemu info transaksi dari voice note ini 🤔",
      msg.messageId,
    );
    return;
  }

  await processParsedItems(db, items, cats, wallets, msg.messageId);
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
  const userReply = msg.text ?? "";

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
      "⚠️ Transaksi tidak ditemukan. Mungkin sudah dihapus sebelumnya.",
      msg.messageId,
    );
    return;
  }

  const [cats, wallets] = await Promise.all([
    getCategories(db),
    getWallets(db),
  ]);
  const expenseCats = cats
    .filter((c) => c.type === "expense")
    .map((c) => c.name);
  const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);

  // Minta Gemini tafsirkan instruksi koreksi
  let instruction;
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
      "⚠️ Gagal memproses instruksi, coba lagi ya.",
      msg.messageId,
    );
    return;
  }

  if (instruction.action === "unclear") {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      `❓ Kurang jelas nih: ${instruction.reason ?? 'coba tulis lebih spesifik ya (mis. "hapus", "500rb", "kategorinya makan")'}`,
      msg.messageId,
    );
    return;
  }

  if (instruction.action === "delete") {
    // Kembalikan balance dompet
    const wallet = wallets.find((w) => w.id === txData.wallet_id);
    if (wallet) {
      const delta = txData.type === "income" ? -txData.amount : txData.amount;
      await db
        .from("wallets")
        .update({
          balance: wallet.balance + delta,
          updated_at: new Date().toISOString(),
        })
        .eq("id", wallet.id);
    }

    await db.from("transactions").delete().eq("id", transactionId);

    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      `🗑️ Transaksi dihapus:\n"${txData.note}" ${formatRupiah(txData.amount)} (${formatTanggalID(txData.date)})`,
      msg.messageId,
    );
    return;
  }

  // action === "edit"
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const oldWallet = wallets.find((w) => w.id === txData.wallet_id);
  const targetWalletId = instruction.wallet
    ? findWalletId(instruction.wallet, wallets)
    : txData.wallet_id;
  const targetWallet = wallets.find((w) => w.id === targetWalletId);
  const newAmount =
    instruction.amount != null && instruction.amount > 0
      ? instruction.amount
      : Number(txData.amount);

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

  // Rekonsiliasi saldo harus dilakukan sekali untuk gabungan edit nominal dan
  // perpindahan dompet: kembalikan dampak lama, lalu terapkan dampak baru.
  const changedFinancialValue =
    newAmount !== Number(txData.amount) || targetWalletId !== txData.wallet_id;
  if (changedFinancialValue && oldWallet && targetWallet) {
    const oldImpact =
      txData.type === "income" ? Number(txData.amount) : -Number(txData.amount);
    const newImpact = txData.type === "income" ? newAmount : -newAmount;
    if (oldWallet.id === targetWallet.id) {
      const balance = oldWallet.balance - oldImpact + newImpact;
      await db
        .from("wallets")
        .update({ balance, updated_at: new Date().toISOString() })
        .eq("id", oldWallet.id);
      oldWallet.balance = balance;
    } else {
      const restoredOld = oldWallet.balance - oldImpact;
      const appliedNew = targetWallet.balance + newImpact;
      await Promise.all([
        db
          .from("wallets")
          .update({
            balance: restoredOld,
            updated_at: new Date().toISOString(),
          })
          .eq("id", oldWallet.id),
        db
          .from("wallets")
          .update({ balance: appliedNew, updated_at: new Date().toISOString() })
          .eq("id", targetWallet.id),
      ]);
      oldWallet.balance = restoredOld;
      targetWallet.balance = appliedNew;
    }
  }

  await db.from("transactions").update(updates).eq("id", transactionId);

  // Refresh dan kirim konfirmasi
  const { data: updatedTx } = await db
    .from("transactions")
    .select("*")
    .eq("id", transactionId)
    .single();

  if (updatedTx) {
    await sendAndMapTx(
      db,
      updatedTx as unknown as TransactionRow,
      wallets,
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
  msg: IncomingMessage,
): Promise<boolean> {
  const amount = parseNominalReply(msg.text ?? "");
  if (!amount) return false;
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("id")
    .eq("access_code", ACCESS_CODE)
    .eq("wa_chat_id", msg.from)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pending?.id) return false;
  await completePendingNominal(db, msg, pending.id, amount);
  return true;
}

async function completePendingNominal(
  db: SupabaseClient,
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
  msg: IncomingMessage,
  pendingId: string,
): Promise<void> {
  const { data: pending } = await db
    .from("wa_pending_transactions")
    .select("*")
    .eq("id", pendingId)
    .single();

  if (!pending) return;

  const amount = parseNominalReply(msg.text ?? "");
  if (!amount) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      OWNER_PHONE,
      '❓ Tidak ketemu angka nominalnya, coba tulis lagi ya (mis. "25rb" atau "25000")',
      msg.messageId,
    );
    return;
  }

  await completePendingNominal(db, msg, pendingId, amount);
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

  const total = wallets.reduce((s, w) => s + (w.balance ?? 0), 0);
  let msg = `💰 Total Saldo: ${formatRupiah(total)}\n\n`;
  for (const w of wallets) {
    msg += `• ${w.name}: ${formatRupiah(w.balance ?? 0)}\n`;
  }

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

  // Kembalikan balance
  const wallets = await getWallets(db);
  const wallet = wallets.find((w) => w.id === tx.wallet_id);
  if (wallet) {
    const delta = tx.type === "income" ? -tx.amount : tx.amount;
    await db
      .from("wallets")
      .update({
        balance: wallet.balance + delta,
        updated_at: new Date().toISOString(),
      })
      .eq("id", wallet.id);
  }

  await db.from("transactions").delete().eq("id", tx.id);

  await sendWhatsAppMessage(
    PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    OWNER_PHONE,
    `🗑️ Transaksi terakhir dihapus:\n"${tx.note}" ${formatRupiah(tx.amount)} (${formatTanggalID(tx.date)})`,
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
