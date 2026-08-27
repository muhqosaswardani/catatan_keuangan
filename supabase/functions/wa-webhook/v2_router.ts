// supabase/functions/wa-webhook/v2_router.ts
// VERSI 2 - Router Utama untuk fitur Stage 2 (Intent & Mode - Revisi Sesi & Balasan)

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppMessage, sendPushNotification, sendUserResponse } from "./whatsapp.ts";
import { getV2Session, saveV2Session, clearV2Session } from "./v2_db.ts";
import { processV2Query } from "./v2_query.ts";
import { handleCekSaldo, getCategories, getWallets, type SpeculativeParseResult } from "./handlers.ts";
import { parseTransactions, annotateSlangNominalForAi, getTodayStr, type GeminiPart } from "./gemini.ts";
import {
  parseV2Intent,
  handleV2ChecklistIntent,
  handleV2TransferIntent,
  handleV2DebtIntent,
  handleV2ClarificationReply
} from "./v2_intents.ts";
import {
  handleModeKoreksiEnter,
  handleModeKoreksiMessage,
  handleModeLimitEnter,
  handleModeLimitMessage,
  handleModeTujuanEnter,
  handleModeTujuanMessage
} from "./v2_modes.ts";

const PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;
const ACCESS_CODE = Deno.env.get("WA_ACCESS_CODE") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Potong balasan panjang jadi kalimat singkat buat body notifikasi push,
 * dipakai saat Balasan WA OFF (user cuma lihat notif, bukan chat WA penuh).
 */
function toShortNotifText(text: string, maxLen = 150): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;

  // Jika ada lebih dari satu kalimat, ambil kalimat pertama jika sudah lengkap
  const firstSentenceMatch = clean.match(/^([^.!?]+[.!?])/);
  if (firstSentenceMatch && firstSentenceMatch[1].length <= maxLen && firstSentenceMatch[1].length >= 15) {
    return firstSentenceMatch[1].trim();
  }

  // Jika tetap melebihi maxLen, potong rapi di batas kata terakhir
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Pusat Bantuan (help/bantuan/menu) - Exits immediately
 */
async function handleHelpCommand(waChatId: string, messageId: string): Promise<void> {
  const helpText = `Pusat Bantuan Catatan Keuangan Bot

*Menu Mode Terkunci (Ketik kata eksak untuk masuk):*
- 'koreksi' : Penyesuaian saldo dompet (kirim foto cash/nominal).
- 'limit' / 'anggaran' : Kelola limit budget pengeluaran bulanan.
- 'tujuan' / 'goals' : Kelola tujuan tabungan keuangan kamu.

*Sub-perintah dalam Mode Terkunci:*
- 'ya' / 'oke' : Konfirmasi aksi final mode.
- 'batal' : Batal dan keluar dari mode tanpa menyimpan.
- Edit/Tambah/Hapus dapat ditulis natural (contoh: 'edit 1 1jt', 'hapus 2').

*Fitur Teks Bebas (Langsung ketik perintah):*
- Tagihan: 'bayar cicilan motor', 'lunasin kuliah' (menandai tagihan lunas).
- Transfer: 'transfer dari utama ke tabungan 500rb', 'pindahin 100rb ke gopay'.
- Utang-Piutang: 'pinjam ke Budi 100rb', 'bayar utang Budi 50rb'.
- Laporan/Query: Tambahkan tanda tanya '?' di akhir kalimat untuk bertanya apa saja (contoh: 'anggaran makan sisa berapa?', 'pengeluaran terbesar bulan ini?').
- Cek Saldo: Ketik 'cek saldo' untuk ringkasan dompet.`;

  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, waChatId, helpText, messageId);
}

/**
 * Fungsi utama routing V2
 * Returns true jika pesan ditangani oleh alur V2.
 * Returns false jika pesan tidak cocok dan harus fallback ke V1.
 */
export async function handleV2Message(
  db: SupabaseClient,
  apiKeys: string[],
  msg: any,
  userId: string,
): Promise<boolean> {
  const text = (msg.text ?? msg.caption ?? "").trim();
  const cleaned = text.toLowerCase();
  const waChatId = msg.from;

  // Ambil status toggle "Balasan WA" di awal — dipakai buat gating Mode Terkunci
  // (sesi aktif maupun masuk mode baru) dan buat jalur Query/Tanya Jawab di bawah.
  let waAutoReply = true;
  const { data: st } = await db.from("user_settings").select("wa_auto_reply").eq("user_id", userId).maybeSingle();
  if (st && typeof st.wa_auto_reply === "boolean") {
    waAutoReply = st.wa_auto_reply;
  }

  // 0. Cek: apakah user sedang berada di dalam MODE TERKUNCI aktif?
  const { session, wasTimedOut } = await getV2Session(db, waChatId);

  // Balasan WA OFF -> semua Mode Terkunci (koreksi/limit/tujuan) diabaikan total,
  // baik yang baru mau masuk maupun sesi yang sedang berjalan. Cukup satu notifikasi
  // pemberitahuan singkat, tidak diproses lebih lanjut (biar user nggak nyangka macet).
  if (session && !wasTimedOut && !waAutoReply) {
    await sendPushNotification(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      userId,
      "Fitur WA Nonaktif",
      "Balasan WA sedang nonaktif, jadi Mode Terkunci diabaikan sementara. Nyalakan lagi di pengaturan atau lanjutkan lewat aplikasi web.",
      { type: "wa_auto_reply_off" }
    );
    return true;
  }

  if (wasTimedOut && session) {
    const modeLabel = session.mode?.toUpperCase() ?? "MODE";
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      waChatId,
      `Mode ${modeLabel} otomatis dibatalkan karena tidak ada aktivitas selama 5 menit. Memproses pesanmu...`
    );
    // Don't return true! Let the message fall through to normal processing below.
  }

  // Jika ada sesi aktif
  if (session && !wasTimedOut) {
    const currentMode = session.mode;

    // Cek jika ada pending exit confirmation
    if (session.session_data?.pending_exit_intent) {
      if (cleaned === "ya" || cleaned === "oke") {
        const pendingMsg = session.session_data.pending_exit_intent;
        await clearV2Session(db, waChatId);
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          `Keluar dari Mode ${currentMode?.toUpperCase()}. Memproses permintaan baru...`
        );
        // Re-run message processing recursively
        return await handleV2Message(db, apiKeys, pendingMsg, userId);
      } else if (cleaned === "tidak" || cleaned === "batal" || cleaned === "batalin") {
        // Hapus pending exit intent dan tetap di mode
        const cleanSessionData = { ...session.session_data };
        delete cleanSessionData.pending_exit_intent;
        await saveV2Session(db, waChatId, userId, currentMode, cleanSessionData);
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          `Tetap berada di dalam Mode ${currentMode?.toUpperCase()}.`
        );
        return true;
      } else {
        await sendWhatsAppMessage(
          PHONE_NUMBER_ID,
          WA_ACCESS_TOKEN,
          waChatId,
          `Mohon balas dengan 'ya' untuk keluar dan memproses permintaan baru, atau 'batal' untuk tetap di mode ${currentMode?.toUpperCase()}.`,
          msg.messageId
        );
        return true;
      }
    }

    // Cek apakah pesan baru ini memicu intent atau mode lain yang akan keluar dari mode aktif
    const isEnterKoreksi = cleaned === "koreksi";
    const isEnterLimit = cleaned === "limit" || cleaned === "anggaran";
    const isEnterTujuan = cleaned === "tujuan" || cleaned === "goals";
    const isEnterHelp = cleaned === "help" || cleaned === "bantuan" || cleaned === "menu";
    const isQuery = text.includes("?") || /^(cek saldo|saldo|berapa saldo|total saldo)/i.test(text);

    // Helper: deteksi input sederhana yang ditujukan untuk active mode
    const isSimpleModeInput = (t: string): boolean => {
      const c = t.trim().toLowerCase();
      if (/^[\d\s,;]+$/.test(c)) return true; // angka / list angka (pilih dompet)
      const words = ["batal", "batalin", "selesai", "simpan", "done", "ok", "yes", "no", "ya", "tidak", "semua", "all", "satu", "dua", "tiga"];
      if (words.includes(c)) return true;
      if (/^\d+[\d\s\.,]*(rb|jt|ribu|juta)?$/i.test(c)) return true; // nominal uang saja
      return false;
    };

    // Deteksi intent teks bebas
    let isFreeTextIntent = false;
    // BANYAKAN BYPASS: jika input sederhana atau ini adalah REPLY (msg.contextId ada), jangan anggap trigger keluar mode
    if (msg.type === "text" && !isEnterKoreksi && !isEnterLimit && !isEnterTujuan && !isEnterHelp && !isQuery && !msg.contextId && !isSimpleModeInput(text)) {
      const parsedIntent = await parseV2Intent(apiKeys, text);
      if (parsedIntent.intent !== "none") {
        isFreeTextIntent = true;
      }
    }

    if (isEnterKoreksi || isEnterLimit || isEnterTujuan || isEnterHelp || isQuery || isFreeTextIntent) {
      // Minta konfirmasi keluar mode
      const updatedData = {
        ...session.session_data,
        pending_exit_intent: {
          messageId: msg.messageId,
          from: msg.from,
          type: msg.type,
          text: msg.text,
          mediaId: msg.mediaId,
          mimeType: msg.mimeType,
          caption: msg.caption
        }
      };
      await saveV2Session(db, waChatId, userId, currentMode, updatedData);
      await sendWhatsAppMessage(
        PHONE_NUMBER_ID,
        WA_ACCESS_TOKEN,
        waChatId,
        `Kamu masih dalam Mode ${currentMode?.toUpperCase()}. Mau keluar dari mode ini dan memproses permintaan baru?\n(Balas 'ya' untuk keluar, atau 'batal' untuk tetap)`,
        msg.messageId
      );
      return true;
    }

    // Proses pesan di dalam mode masing-masing
    if (currentMode === "koreksi") {
      await handleModeKoreksiMessage(db, apiKeys, msg, session, userId);
    } else if (currentMode === "limit") {
      await handleModeLimitMessage(db, apiKeys, msg, session, userId);
    } else if (currentMode === "tujuan") {
      await handleModeTujuanMessage(db, apiKeys, msg, session, userId);
    }
    return true;
  }

  // 1. Cek: apakah pesan ini trigger MASUK mode (exact match, case-insensitive)?
  if (cleaned === "koreksi" || cleaned === "limit" || cleaned === "anggaran" || cleaned === "tujuan" || cleaned === "goals") {
    if (!waAutoReply) {
      await sendPushNotification(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        userId,
        "Fitur WA Nonaktif",
        "Fitur ini perlu balasan WA aktif — nyalakan di pengaturan, atau pakai fitur ini langsung di aplikasi web."
      );
      return true;
    }
  }

  if (cleaned === "koreksi") {
    await handleModeKoreksiEnter(db, waChatId, msg.messageId, userId);
    return true;
  }
  if (cleaned === "limit" || cleaned === "anggaran") {
    await handleModeLimitEnter(db, waChatId, msg.messageId, userId);
    return true;
  }
  if (cleaned === "tujuan" || cleaned === "goals") {
    await handleModeTujuanEnter(db, waChatId, msg.messageId, userId);
    return true;
  }
  if (cleaned === "help" || cleaned === "bantuan" || cleaned === "menu") {
    await handleHelpCommand(waChatId, msg.messageId);
    return true;
  }

  // 2. Cek: apakah ini REPLY ke pertanyaan klarifikasi pending?
  if (msg.contextId) {
    const { data: pending } = await db
      .from("wa_pending_transactions")
      .select("*")
      .eq("wa_question_message_id", msg.contextId)
      .maybeSingle();

    if (pending) {
      const pData = typeof pending.pending_data === "string" ? JSON.parse(pending.pending_data) : pending.pending_data;
      if (pData.type === "clarify_checklist" || pData.type === "clarify_debt_payment") {
        await handleV2ClarificationReply(db, apiKeys, msg, pData, userId);
        // Hapus pending entry
        await db.from("wa_pending_transactions").delete().eq("id", pending.id);
        return true;
      }
    }
  }

  // 3. ROUTER INTENT VERSI 2 - Teks bebas (checklist -> transfer -> utang-piutang)
  // Jika ada contextId (reply ke pesan/transaksi), skip intent parsing - biarkan index.ts menangani
  if (msg.contextId) return false;

  if (msg.type === "text") {
    // 3.1. Cek: apakah pesan murni cek saldo tanpa tanya "?" (Bypass Gemini)
    const isPureCekSaldo = /^(cek saldo|saldo|berapa saldo|total saldo)/i.test(text.trim()) && !text.includes("?");
    if (isPureCekSaldo) {
      await handleCekSaldo(db, msg.from, msg.messageId, userId);
      return true;
    }

    // OPTIMISASI KECEPATAN: jalankan parseTransactions (jalur V1/handleTextMessage)
    // secara PARALEL dengan klasifikasi intent V2 di bawah, bukan menunggu intent
    // selesai dulu baru mulai. Kalau nanti pesan ini memang fallback ke V1 (intent
    // "none"), handleTextMessage tinggal pakai hasil yang sudah siap - logic/hasil
    // akhirnya tidak berubah sama sekali, cuma latensinya dipotong karena 2 panggilan
    // Gemini yang independen jalan bersamaan, bukan bergantian.
    (msg as { _speculativeTextParse?: Promise<SpeculativeParseResult | { error: Error }> })
      ._speculativeTextParse = (async (): Promise<SpeculativeParseResult | { error: Error }> => {
        try {
          const [cats, wallets] = await Promise.all([
            getCategories(db, userId),
            getWallets(db, userId),
          ]);
          const expenseCats = cats.filter((c) => c.type === "expense").map((c) => c.name);
          const incomeCats = cats.filter((c) => c.type === "income").map((c) => c.name);
          const annotatedText = annotateSlangNominalForAi(text);
          const parts: GeminiPart[] = [{ text: `TEKS_BEBAS_DARI_USER: ${annotatedText}` }];
          const items = await parseTransactions(apiKeys, parts, expenseCats, incomeCats, getTodayStr());
          return { cats, wallets, items };
        } catch (e) {
          return { error: e as Error };
        }
      })();

    const parsed = await parseV2Intent(apiKeys, text);

    if (parsed.intent === "checklist") {
      const ok = await handleV2ChecklistIntent(db, apiKeys, msg.from, msg.messageId, text, parsed.checklist, userId);
      if (ok) return true;
    }
    if (parsed.intent === "transfer") {
      const ok = await handleV2TransferIntent(db, apiKeys, msg.from, msg.messageId, parsed.transfer, userId);
      if (ok) return true;
    }
    if (parsed.intent === "debt") {
      const ok = await handleV2DebtIntent(db, apiKeys, msg.from, msg.messageId, text, parsed.debt, userId);
      if (ok) return true;
    }
    if (parsed.intent === "query" || parsed.intent === "general_chat") {
      const reply = await processV2Query(db, apiKeys, userId, text, !waAutoReply);
      await sendUserResponse(
        db, PHONE_NUMBER_ID, WA_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
        userId, waChatId, reply, msg.messageId,
        { title: "Jawaban Asisten KaslyAI", body: toShortNotifText(reply), data: { type: "query_response" } }
      );
      return true;
    }
  }

  // 4. Cek: apakah pesan mengandung tanda tanya "?"
  const isQuery = text.includes("?");
  if (isQuery) {
    const reply = await processV2Query(db, apiKeys, userId, text, !waAutoReply);
    await sendUserResponse(
      db, PHONE_NUMBER_ID, WA_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
      userId, waChatId, reply, msg.messageId,
      { title: "Jawaban Asisten KaslyAI", body: toShortNotifText(reply), data: { type: "query_response" } }
    );
    return true;
  }

  // 5. Fallback ke alur Versi 1
  return false;
}
