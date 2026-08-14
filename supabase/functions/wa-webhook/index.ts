// supabase/functions/wa-webhook/index.ts
// Entry point utama Supabase Edge Function
// Menangani: GET (webhook verification) + POST (pesan masuk)

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto as webCrypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import {
  handleTextMessage,
  processQueuedMediaBatch,
  handleReplyToTransaction,
  handlePendingNominalReply,
  isOwner,
  BATCH_WINDOW_MS,
  PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN,
} from "./handlers.ts";
import { handleV2Message } from "./v2_router.ts";
import { sendWhatsAppMessage, markAsRead, sendTypingIndicator } from "./whatsapp.ts";

// ============================================================
// ENV VARS (diset di Supabase Edge Function Secrets)
// ============================================================

const VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN");
const APP_SECRET = Deno.env.get("WA_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEYS_RAW = Deno.env.get("GEMINI_API_KEYS") ?? "";

// Parse multiple Gemini API keys (comma-separated)
const GEMINI_API_KEYS: string[] = GEMINI_API_KEYS_RAW.split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// ============================================================
// Supabase client (service role — bypass RLS untuk edge function)
// ============================================================

function getDb() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function claimIncomingMessage(
  db: ReturnType<typeof getDb>,
  messageId: string,
): Promise<boolean> {
  const { error } = await db.from("wa_processed_messages").insert({
    wa_message_id: messageId,
    access_code: Deno.env.get("WA_ACCESS_CODE"),
  });
  if (!error) return true;
  // PostgreSQL unique_violation = webhook delivery yang pernah diproses.
  if (error.code === "23505") return false;
  throw new Error(`Gagal claim pesan WA: ${error.message}`);
}

// ============================================================
// Verifikasi signature X-Hub-Signature-256 dari Meta
// ============================================================

async function verifySignature(
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !APP_SECRET) return false;

  const expected = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  const key = await webCrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await webCrypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const computed = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computed.length !== expected.length) return false;
  let different = 0;
  for (let i = 0; i < computed.length; i++)
    different |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}

// ============================================================
// Parse payload WA → IncomingMessage
// ============================================================

interface IncomingMessage {
  messageId: string;
  from: string;
  type: "text" | "image" | "audio" | "other";
  text?: string;
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  contextId?: string;
}

function parseWaPayload(payload: Record<string, unknown>): IncomingMessage[] {
  const messages: IncomingMessage[] = [];

  try {
    const entry = (payload.entry as Record<string, unknown>[])?.[0];
    const changes = (entry?.changes as Record<string, unknown>[])?.[0];
    const value = changes?.value as Record<string, unknown>;
    const msgs = value?.messages as Record<string, unknown>[];

    if (!msgs?.length) return [];

    for (const m of msgs) {
      const msgType = m.type as string;
      const from = m.from as string;
      const messageId = m.id as string;
      const contextId = (m.context as Record<string, unknown>)?.id as
        | string
        | undefined;

      if (msgType === "text") {
        messages.push({
          messageId,
          from,
          type: "text",
          text: (m.text as Record<string, unknown>)?.body as string,
          contextId,
        });
      } else if (msgType === "image") {
        const img = m.image as Record<string, unknown>;
        messages.push({
          messageId,
          from,
          type: "image",
          mediaId: img?.id as string,
          mimeType: img?.mime_type as string,
          caption: img?.caption as string,
          contextId,
        });
      } else if (msgType === "audio") {
        const aud = m.audio as Record<string, unknown>;
        messages.push({
          messageId,
          from,
          type: "audio",
          mediaId: aud?.id as string,
          mimeType: aud?.mime_type as string,
          contextId,
        });
      } else {
        messages.push({ messageId, from, type: "other", contextId });
      }
    }
  } catch (e) {
    console.error("parseWaPayload error:", e);
  }

  return messages;
}

const BATCH_DELAY_MS = BATCH_WINDOW_MS + 150;

async function enqueueAndScheduleMedia(
  db: ReturnType<typeof getDb>,
  apiKeys: string[],
  msg: IncomingMessage,
): Promise<void> {
  const { error } = await db.from("wa_media_queue").upsert(
    {
      wa_message_id: msg.messageId,
      access_code: Deno.env.get("WA_ACCESS_CODE"),
      wa_chat_id: msg.from,
      media_id: msg.mediaId,
      mime_type:
        msg.mimeType ?? (msg.type === "audio" ? "audio/ogg" : "image/jpeg"),
      media_kind: msg.type,
      caption: msg.caption ?? null,
    },
    { onConflict: "wa_message_id", ignoreDuplicates: true },
  );
  if (error)
    throw new Error(`Gagal memasukkan media ke batch: ${error.message}`);

  EdgeRuntime.waitUntil(
    (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        await processQueuedMediaBatch(db, apiKeys, msg.from);
      } catch (e) {
        console.error("Error in background media batch processing:", e);
        try {
          await sendWhatsAppMessage(
            PHONE_NUMBER_ID,
            WA_ACCESS_TOKEN,
            msg.from,
            "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
            msg.messageId,
          );
        } catch (sendErr) {
          console.error("Failed to send background error message:", sendErr);
        }
      }
    })(),
  );
}

// ============================================================
// MAIN HANDLER
// ============================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Webhook verification dari Meta ──────────────────
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (VERIFY_TOKEN && mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Pesan masuk dari Meta ──────────────────────────
  if (req.method === "POST") {
    if (
      !APP_SECRET ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY ||
      !GEMINI_API_KEYS.length ||
      !Deno.env.get("WA_ACCESS_CODE") ||
      !Deno.env.get("WA_DEFAULT_WALLET_ID") ||
      !PHONE_NUMBER_ID ||
      !WA_ACCESS_TOKEN
    ) {
      console.error(
        "WhatsApp webhook belum dikonfigurasi lengkap di Edge Function Secrets.",
      );
      return new Response("Service unavailable", { status: 503 });
    }
    const rawBody = await req.text();

    // Verifikasi signature (keamanan)
    const signature = req.headers.get("X-Hub-Signature-256");
    const valid = await verifySignature(rawBody, signature);
    if (!valid) {
      console.warn("Signature verification failed");
      // Tetap return 200 ke Meta supaya tidak retry, tapi tidak proses
      return new Response("OK", { status: 200 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("OK", { status: 200 });
    }

    const messages = parseWaPayload(payload);
    if (!messages.length) return new Response("OK", { status: 200 });

    const db = getDb();

    // Proses setiap pesan (biasanya cuma 1 per webhook call)
    for (const msg of messages) {
      // Security: hanya proses pesan dari pemilik produk
      if (!isOwner(msg.from)) {
        console.warn(`Ignored message from non-owner: ${msg.from}`);
        continue;
      }

      if (!(await claimIncomingMessage(db, msg.messageId))) {
        console.log(`Duplicate webhook message ignored: ${msg.messageId}`);
        continue;
      }

      // Mark as read (background, tidak await)
      markAsRead(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId).catch(
        () => {},
      );

      // Typing Indicator (Additive Feature)
      if (msg.type === "text" || msg.type === "image" || msg.type === "audio") {
        (async () => {
          try {
            let shouldShowTyping = true;
            if (msg.type === "image" || msg.type === "audio") {
              const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
              const { data: existingMedia } = await db
                .from("wa_media_queue")
                .select("wa_message_id")
                .eq("access_code", Deno.env.get("WA_ACCESS_CODE"))
                .eq("wa_chat_id", msg.from)
                .is("processed_at", null)
                .gt("received_at", tenSecondsAgo)
                .limit(1);
              if (existingMedia && existingMedia.length > 0) {
                shouldShowTyping = false;
              }
            }
            if (shouldShowTyping) {
              await sendTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId);
            }
          } catch (err) {
            console.warn("Failed to process typing indicator:", err);
          }
        })();
      }

      try {
        // // VERSI 2 - Router Intent & Mode (Isolatable & Rollbackable)
        if (Deno.env.get("WA_V2_ENABLED") === "true") {
          // Log incoming message metadata (non-blocking)
          try {
            // @ts-ignore
            EdgeRuntime.waitUntil(
              db.from("wa_logs").insert({
                message: "Incoming Message metadata",
                details: { messageId: msg.messageId, from: msg.from, type: msg.type, text: msg.text ?? msg.caption }
              })
            );
          } catch {
            db.from("wa_logs").insert({
              message: "Incoming Message metadata",
              details: { messageId: msg.messageId, from: msg.from, type: msg.type, text: msg.text ?? msg.caption }
            }).catch(() => {});
          }

          const handled = await handleV2Message(db, GEMINI_API_KEYS, msg);

          // Log V2 Router finished (non-blocking)
          try {
            // @ts-ignore
            EdgeRuntime.waitUntil(
              db.from("wa_logs").insert({
                message: "V2 Router finished",
                details: { messageId: msg.messageId, handled }
              })
            );
          } catch {
            db.from("wa_logs").insert({
              message: "V2 Router finished",
              details: { messageId: msg.messageId, handled }
            }).catch(() => {});
          }

          if (handled) {
            continue;
          }
        }

        // ── Cek apakah ini reply ke pesan bot ──────────────
        if (msg.contextId) {
          // Cek apakah reply ke bubble transaksi
          const { data: mapping } = await db
            .from("wa_message_transactions")
            .select("transaction_id")
            .eq("wa_message_id", msg.contextId)
            .single();

          if (mapping?.transaction_id) {
            await handleReplyToTransaction(
              db,
              GEMINI_API_KEYS,
              msg,
              mapping.transaction_id,
            );
            continue;
          }

          // Cek apakah reply ke pertanyaan nominal pending
          const { data: pending } = await db
            .from("wa_pending_transactions")
            .select("id")
            .eq("wa_question_message_id", msg.contextId)
            .single();

          if (pending?.id) {
            await handlePendingNominalReply(db, GEMINI_API_KEYS, msg, pending.id);
            continue;
          }

          // Reply ke pesan lain yang tidak dikenali → proses normal
        }

        // ── Route berdasarkan tipe pesan ────────────────────
        if (msg.type === "text") {
          await handleTextMessage(db, GEMINI_API_KEYS, msg);
        } else if (msg.type === "image" || msg.type === "audio") {
          // Foto dan VN memakai queue batch yang sama supaya pesan beruntun
          // dikirim ke Gemini dalam satu panggilan.
          await enqueueAndScheduleMedia(db, GEMINI_API_KEYS, msg);
        }
        // "other" types: abaikan
      } catch (e) {
        console.error("Error processing message:", e);
        // Kirim pesan error ke user
        try {
          await sendWhatsAppMessage(
            PHONE_NUMBER_ID,
            WA_ACCESS_TOKEN,
            msg.from,
            "Maaf, ada kesalahan internal. Coba lagi ya.",
            msg.messageId,
          );
        } catch {}
      }
    }

    // Selalu return 200 ke Meta (supaya tidak retry)
    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
