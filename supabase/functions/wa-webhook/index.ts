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
  handleWebChatImage,
  BATCH_WINDOW_MS,
  PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN,
} from "./handlers.ts";
import { handleV2Message } from "./v2_router.ts";
import { sendWhatsAppMessage, markAsRead, withTypingIndicator, chatContext, ChatContextMessage } from "./whatsapp.ts";
import { getV2Session } from "./v2_db.ts";

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
  userId?: string,
): Promise<boolean> {
  const { error } = await db.from("wa_processed_messages").insert({
    wa_message_id: messageId,
    user_id: userId || null,
    access_code: userId ? "wa_" + userId : Deno.env.get("WA_ACCESS_CODE"),
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

// ============================================================
// REGISTRATION & MULTI-USER HELPERS
// ============================================================

function generateOtpCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 20; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateTempPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function getUserByWa(db: any, nomorWa: string) {
  const { data, error } = await db
    .from("users")
    .select("id, status_verifikasi")
    .eq("nomor_wa", nomorWa)
    .maybeSingle();
  if (error) {
    console.error("Error fetching user by WA:", error);
    return null;
  }
  return data;
}

async function initializeUserData(db: any, userId: string) {
  const accessCode = "wa_" + userId;

  // 1. Insert default wallet "Dompet Utama"
  const walletId = `wa_w_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.from("wallets").insert({
    id: walletId,
    user_id: userId,
    access_code: accessCode,
    name: "Dompet Utama",
    balance: 0,
    is_primary: true,
    sort_order: 0
  });

  // 2. Insert default categories
  const presetExpense = [
    { name: "Makan", icon: "utensils", color: "#ef4444" },
    { name: "Transport", icon: "car", color: "#3b82f6" },
    { name: "Belanja", icon: "shopping-bag", color: "#ec4899" },
    { name: "Tagihan", icon: "credit-card", color: "#f59e0b" },
    { name: "Hiburan", icon: "film", color: "#8b5cf6" },
    { name: "Lainnya", icon: "folder", color: "#6b7280" },
    { name: "Penyesuaian Saldo", icon: "sliders", color: "#10b981" },
    { name: "Transfer", icon: "refresh", color: "#6b7280" },
    { name: "Utang Piutang", icon: "users", color: "#3b82f6" }
  ];

  const presetIncome = [
    { name: "Gaji", icon: "briefcase", color: "#10b981" },
    { name: "Bonus", icon: "gift", color: "#f59e0b" },
    { name: "Lainnya", icon: "folder", color: "#6b7280" }
  ];

  const catInserts = [];
  for (const cat of presetExpense) {
    catInserts.push({
      id: `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: userId,
      access_code: accessCode,
      name: cat.name,
      type: "expense",
      icon: cat.icon,
      color: cat.color
    });
  }

  for (const cat of presetIncome) {
    catInserts.push({
      id: `wa_cat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: userId,
      access_code: accessCode,
      name: cat.name,
      type: "income",
      icon: cat.icon,
      color: cat.color
    });
  }

  await db.from("categories").insert(catInserts);

  // 3. Insert default user_settings
  await db.from("user_settings").insert({
    user_id: userId,
    access_code: accessCode,
    deleted_ids: [],
    nav_config: { initialBalances: {} }
  });
}

function generateSetupToken(): string {
  return crypto.randomUUID();
}

const PASSWORD_SETUP_TTL_MS = 15 * 60 * 1000; // 15 menit

async function issuePasswordSetupToken(db: any, userId: string): Promise<string> {
  const setupToken = generateSetupToken();
  await db
    .from("users")
    .update({
      password_setup_token: setupToken,
      password_setup_expires_at: new Date(Date.now() + PASSWORD_SETUP_TTL_MS).toISOString(),
    })
    .eq("id", userId);
  return setupToken;
}

async function verifyOtpViaChat(
  db: any,
  nomorWa: string,
  otpCode: string,
  replyToMsgId: string
): Promise<boolean> {
  const { data: verif, error: verifErr } = await db
    .from("verifikasi_wa")
    .select("*")
    .eq("nomor_wa", nomorWa)
    .eq("kode", otpCode)
    .eq("status", "pending")
    .maybeSingle();

  if (verifErr || !verif) {
    return false;
  }

  if (new Date(verif.expires_at) < new Date()) {
    await sendWhatsAppMessage(
      PHONE_NUMBER_ID,
      WA_ACCESS_TOKEN,
      nomorWa,
      "Maaf, kode verifikasi tersebut sudah kedaluwarsa. Silakan ulangi proses dari aplikasi web KaslyAI.",
      replyToMsgId
    );
    await db.from("verifikasi_wa").delete().eq("kode", otpCode);
    return true;
  }

  const { data: user } = await db
    .from("users")
    .select("*")
    .eq("nomor_wa", nomorWa)
    .maybeSingle();

  if (!user) {
    return false;
  }

  const isNewRegistration = user.status_verifikasi !== "verified";

  if (isNewRegistration) {
    if (user.token_dipakai) {
      await db
        .from("tokens")
        .update({
          status: "used",
          used_by: nomorWa,
          used_at: new Date().toISOString()
        })
        .eq("code", user.token_dipakai);
    }

    await db
      .from("users")
      .update({ status_verifikasi: "verified" })
      .eq("id", user.id);

    await initializeUserData(db, user.id);
  }

  await db.from("verifikasi_wa").delete().eq("kode", otpCode);

  // Password TIDAK pernah dibuat otomatis dan TIDAK pernah dikirim via WA.
  // User akan membuat kata sandinya sendiri di aplikasi web menggunakan setup token ini.
  await issuePasswordSetupToken(db, user.id);

  const confirmationMsg = isNewRegistration
    ? `Verifikasi berhasil! Akun KaslyAI Anda telah aktif.\n\nSilakan kembali ke aplikasi web KaslyAI untuk membuat kata sandi Anda sendiri.`
    : `Verifikasi berhasil! Silakan kembali ke aplikasi web KaslyAI untuk membuat kata sandi baru Anda.`;
  await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, nomorWa, confirmationMsg, replyToMsgId);

  return true;
}

// ============================================================
// MAIN HANDLER
// ============================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Dynamically set CORS headers based on request origin and allow credentials
  const requestOrigin = req.headers.get("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-web-chat",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json"
  };

  // ── OPTIONS: CORS preflight ──────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }

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

  // ── POST: Pesan masuk atau HTTP API request ──────────────
  if (req.method === "POST") {
    const rawBody = await req.text();
    const isWebChat = req.headers.get("x-web-chat") === "true" || url.searchParams.get("web_chat") === "true";

    // ── ENDPOINTS REGISTRASI USER ────────────────────────────
    if (url.pathname.endsWith("/start-registration")) {
      try {
        const db = getDb();
        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { nomor_wa, nama, token } = payload;
        if (!nomor_wa || !nama) {
          return new Response(JSON.stringify({ error: "Nomor WA dan Nama wajib diisi." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const nomorWa = nomor_wa.replace(/\D/g, "").replace(/^0/, "62");

        if (token) {
          const { data: tokenData, error: tokenErr } = await db
            .from("tokens")
            .select("*")
            .eq("code", token)
            .eq("status", "available")
            .maybeSingle();

          if (tokenErr || !tokenData) {
            return new Response(JSON.stringify({ error: "Token trial tidak valid atau sudah digunakan." }), {
              status: 400,
              headers: corsHeaders,
            });
          }
        }

        const { data: existingUser } = await db
          .from("users")
          .select("*")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        if (existingUser && existingUser.status_verifikasi === "verified") {
          return new Response(JSON.stringify({
            error: "Nomor WhatsApp ini sudah terdaftar. Silakan masuk memakai kata sandi Anda.",
            code: "ALREADY_REGISTERED",
          }), {
            status: 409,
            headers: corsHeaders,
          });
        }

        const otpCode = generateOtpCode();
        const email = `${nomorWa}@kaslyai.local`;
        let userId: string;
        // passwordTemp di sini HANYA placeholder internal untuk memenuhi requirement Supabase Auth
        // (createUser/updateUserById butuh sebuah password). User TIDAK PERNAH melihat/memakai ini —
        // kata sandi asli dibuat sendiri oleh user lewat alur "Buat Kata Sandi" setelah verifikasi WA.
        let passwordTemp: string;

        if (existingUser && existingUser.status_verifikasi === "pending") {
          userId = existingUser.id;
          passwordTemp = generateTempPassword();
          const { data: authUser } = await db.auth.admin.getUserById(userId);
          const userMeta = authUser?.user?.user_metadata || {};
          const { error: updateAuthErr } = await db.auth.admin.updateUserById(userId, {
            password: passwordTemp,
            user_metadata: { ...userMeta, password_temp: passwordTemp }
          });
          if (updateAuthErr) {
            return new Response(JSON.stringify({ error: `Gagal memperbarui auth: ${updateAuthErr.message}` }), {
              status: 500,
              headers: corsHeaders,
            });
          }
          if (token) {
            await db.from("users").update({ token_dipakai: token, trial_lama_hari: 30 }).eq("id", userId);
          }
        } else {
          passwordTemp = generateTempPassword();
          const { data: authData, error: authErr } = await db.auth.admin.createUser({
            email,
            password: passwordTemp,
            email_confirm: true,
            user_metadata: { nama, nomor_wa: nomorWa, password_temp: passwordTemp }
          });

          if (authErr || !authData?.user) {
            return new Response(JSON.stringify({ error: `Gagal membuat akun auth: ${authErr?.message}` }), {
              status: 500,
              headers: corsHeaders,
            });
          }

          userId = authData.user.id;

          const { error: profileErr } = await db.from("users").insert({
            id: userId,
            nama,
            nomor_wa: nomorWa,
            status_verifikasi: "pending",
            trial_mulai_at: new Date().toISOString(),
            trial_lama_hari: token ? 30 : 7,
            token_dipakai: token || null,
            sumber_ai: "gratis"
          });

          if (profileErr) {
            await db.auth.admin.deleteUser(userId);
            return new Response(JSON.stringify({ error: `Gagal membuat profil user: ${profileErr.message}` }), {
              status: 500,
              headers: corsHeaders,
            });
          }
        }

        const { error: verifErr } = await db.from("verifikasi_wa").upsert({
          kode: otpCode,
          nomor_wa: nomorWa,
          password_temp: passwordTemp,
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });

        if (verifErr) {
          return new Response(JSON.stringify({ error: `Gagal menyimpan verifikasi: ${verifErr.message}` }), {
            status: 500,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({ success: true, message: "Silakan verifikasi pendaftaran Anda dengan mengirimkan kode OTP via WhatsApp.", code: otpCode }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in start-registration:", err);
        return new Response(JSON.stringify({ error: `Server Error: ${(err as Error).message || err}` }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname.endsWith("/check-verification")) {
      try {
        const db = getDb();
        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { nomor_wa } = payload;
        if (!nomor_wa) {
          return new Response(JSON.stringify({ error: "Nomor WA wajib diisi." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const nomorWa = nomor_wa.replace(/\D/g, "").replace(/^0/, "62");

        const { data: user, error } = await db
          .from("users")
          .select("status_verifikasi, password_setup_token, password_setup_expires_at")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        if (error || !user) {
          return new Response(JSON.stringify({ verified: false }), {
            status: 200,
            headers: corsHeaders,
          });
        }

        // Untuk user baru, status_verifikasi baru jadi 'verified' setelah kode WA diproses.
        // Untuk alur Lupa Kata Sandi, status_verifikasi sudah 'verified' dari sebelumnya, jadi
        // yang jadi penanda "kode WA baru saja dikonfirmasi" adalah setup token yang masih fresh
        // (diterbitkan oleh verifyOtpViaChat pada saat itu juga).
        const hasFreshSetupToken = !!user.password_setup_token &&
          !!user.password_setup_expires_at &&
          new Date(user.password_setup_expires_at) > new Date();

        const verified = user.status_verifikasi === "verified" && hasFreshSetupToken;

        return new Response(JSON.stringify({ verified }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in check-verification:", err);
        return new Response(JSON.stringify({ error: `Server Error: ${(err as Error).message || err}` }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname.endsWith("/complete-verification")) {
      try {
        const db = getDb();
        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { nomor_wa } = payload;
        if (!nomor_wa) {
          return new Response(JSON.stringify({ error: "Nomor WA wajib diisi." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const nomorWa = nomor_wa.replace(/\D/g, "").replace(/^0/, "62");

        // Verifikasi kode WA yang sesungguhnya (kode+nomor+pengirim) sudah terjadi lewat
        // pesan WhatsApp masuk (lihat verifyOtpViaChat), yang juga menerbitkan setup token
        // kata sandi. Endpoint ini hanya boleh dipanggil SETELAH check-verification bilang
        // sudah verified, dan tugasnya cuma menyerahkan setup token itu ke frontend.
        const { data: user } = await db
          .from("users")
          .select("*")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        if (!user) {
          return new Response(JSON.stringify({ error: "Profil user tidak ditemukan." }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        if (user.status_verifikasi !== "verified") {
          return new Response(JSON.stringify({ error: "Verifikasi WhatsApp belum selesai. Silakan kirim kode OTP terlebih dahulu." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        if (!user.password_setup_token || !user.password_setup_expires_at || new Date(user.password_setup_expires_at) < new Date()) {
          return new Response(JSON.stringify({ error: "Sesi pembuatan kata sandi sudah kedaluwarsa. Silakan ulangi verifikasi WhatsApp." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: "Verifikasi berhasil. Silakan buat kata sandi Anda.",
          email: `${nomorWa}@kaslyai.local`,
          setupToken: user.password_setup_token
        }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in complete-verification:", err);
        return new Response(JSON.stringify({ error: `Server Error: ${(err as Error).message || err}` }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // ── LUPA KATA SANDI: minta kode verifikasi WA ulang untuk user yang sudah terdaftar ──
    if (url.pathname.endsWith("/request-password-reset")) {
      try {
        const db = getDb();
        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { nomor_wa } = payload;
        if (!nomor_wa) {
          return new Response(JSON.stringify({ error: "Nomor WA wajib diisi." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const nomorWa = nomor_wa.replace(/\D/g, "").replace(/^0/, "62");

        const { data: user } = await db
          .from("users")
          .select("*")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        if (!user || user.status_verifikasi !== "verified") {
          return new Response(JSON.stringify({ error: "Nomor WhatsApp ini belum terdaftar. Silakan daftar akun baru." }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        const otpCode = generateOtpCode();

        const { error: verifErr } = await db.from("verifikasi_wa").upsert({
          kode: otpCode,
          nomor_wa: nomorWa,
          password_temp: generateTempPassword(), // placeholder, kolom NOT NULL, tidak dipakai untuk auth
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });

        if (verifErr) {
          return new Response(JSON.stringify({ error: `Gagal menyimpan verifikasi: ${verifErr.message}` }), {
            status: 500,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({ success: true, message: "Silakan verifikasi ulang lewat WhatsApp untuk membuat kata sandi baru.", code: otpCode }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in request-password-reset:", err);
        return new Response(JSON.stringify({ error: `Server Error: ${(err as Error).message || err}` }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // ── SET PASSWORD: user membuat kata sandinya sendiri (dipakai di alur Daftar & Lupa Sandi) ──
    if (url.pathname.endsWith("/set-password")) {
      try {
        const db = getDb();
        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { nomor_wa, setup_token, password } = payload;
        if (!nomor_wa || !setup_token || !password) {
          return new Response(JSON.stringify({ error: "Data tidak lengkap." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        if (typeof password !== "string" || password.length < 8) {
          return new Response(JSON.stringify({ error: "Kata sandi minimal 8 karakter." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const nomorWa = nomor_wa.replace(/\D/g, "").replace(/^0/, "62");

        const { data: user } = await db
          .from("users")
          .select("*")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        if (!user) {
          return new Response(JSON.stringify({ error: "Profil user tidak ditemukan." }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        if (
          !user.password_setup_token ||
          user.password_setup_token !== setup_token ||
          !user.password_setup_expires_at ||
          new Date(user.password_setup_expires_at) < new Date()
        ) {
          return new Response(JSON.stringify({ error: "Sesi pembuatan kata sandi tidak valid atau sudah kedaluwarsa. Silakan ulangi verifikasi WhatsApp." }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { error: updateErr } = await db.auth.admin.updateUserById(user.id, { password });
        if (updateErr) {
          return new Response(JSON.stringify({ error: `Gagal menyimpan kata sandi: ${updateErr.message}` }), {
            status: 500,
            headers: corsHeaders,
          });
        }

        await db
          .from("users")
          .update({ password_setup_token: null, password_setup_expires_at: null })
          .eq("id", user.id);

        return new Response(JSON.stringify({
          success: true,
          message: "Kata sandi berhasil dibuat.",
          email: `${nomorWa}@kaslyai.local`
        }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in set-password:", err);
        return new Response(JSON.stringify({ error: `Server Error: ${(err as Error).message || err}` }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (isWebChat) {
      const db = getDb();
      let webPayload: Record<string, any>;
      try {
        webPayload = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: corsHeaders
        });
      }

      const msg = {
        messageId: webPayload.messageId || ("msg_web_" + Math.random().toString(36).slice(2, 9)),
        from: webPayload.from || "6281226964679", // default to owner phone
        type: webPayload.image ? "image" : "text",
        text: webPayload.text || "",
        contextId: webPayload.contextId || null
      };

      // Resolve userId
      let userId: string | null = null;
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        const token = authHeader.replace("Bearer ", "");
        const { data: { user } } = await db.auth.getUser(token);
        if (user) {
          userId = user.id;
        }
      }

      if (!userId && msg.from) {
        const user = await getUserByWa(db, msg.from);
        if (user && user.status_verifikasi === "verified") {
          userId = user.id;
        }
      }

      if (!userId && isOwner(msg.from)) {
        userId = "da7b12d5-e9df-46cc-a4ba-f3a748c08412";
      }

      if (!userId) {
        return new Response(JSON.stringify({ error: "Unauthorized. Mohon login terlebih dahulu." }), {
          status: 401,
          headers: corsHeaders
        });
      }

      const responseMessages: ChatContextMessage[] = [];

      try {
        await chatContext.run({ isWebChat: true, messages: responseMessages }, async () => {
          if (webPayload.image && webPayload.image.data && webPayload.image.mimeType) {
            await handleWebChatImage(db, GEMINI_API_KEYS, msg, webPayload.image.data, webPayload.image.mimeType, userId);
            return;
          }

          // 1. Cek V2 Message router
          const handled = await handleV2Message(db, GEMINI_API_KEYS, msg, userId);
          if (handled) return;

          // 2. Cek reply to transaction
          if (msg.contextId) {
            const { data: mapping } = await db
              .from("wa_message_transactions")
              .select("transaction_id")
              .eq("wa_message_id", msg.contextId)
              .maybeSingle();

            if (mapping?.transaction_id) {
              await handleReplyToTransaction(db, GEMINI_API_KEYS, msg, mapping.transaction_id, userId);
              return;
            }

            const { data: pending } = await db
              .from("wa_pending_transactions")
              .select("id")
              .eq("wa_question_message_id", msg.contextId)
              .maybeSingle();

            if (pending?.id) {
              await handlePendingNominalReply(db, GEMINI_API_KEYS, msg, pending.id, userId);
              return;
            }
          }

          // 3. Fallback to normal text handler
          await handleTextMessage(db, GEMINI_API_KEYS, msg, userId);
        });

        const { session: activeSession, wasTimedOut } = await getV2Session(db, msg.from);
        const isSessionActive = !!(activeSession && !wasTimedOut);

        const mappedMessages = [];
        for (const rMsg of responseMessages) {
          const { data: mapping } = await db
            .from("wa_message_transactions")
            .select("transaction_id")
            .eq("wa_message_id", rMsg.messageId)
            .maybeSingle();

          mappedMessages.push({
            text: rMsg.text,
            messageId: rMsg.messageId,
            txId: mapping?.transaction_id || null,
            isClarify: isSessionActive
          });
        }

        return new Response(JSON.stringify({ success: true, messages: mappedMessages }), {
          status: 200,
          headers: corsHeaders
        });
      } catch (e) {
        console.error("Web Chat processing error:", e);
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    if (
      !APP_SECRET ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY ||
      !GEMINI_API_KEYS.length ||
      !Deno.env.get("WA_DEFAULT_WALLET_ID") ||
      !PHONE_NUMBER_ID ||
      !WA_ACCESS_TOKEN
    ) {
      console.error(
        "WhatsApp webhook belum dikonfigurasi lengkap di Edge Function Secrets.",
      );
      return new Response("Service unavailable", { status: 503 });
    }

    // Verifikasi signature (keamanan)
    const signature = req.headers.get("X-Hub-Signature-256");
    const valid = await verifySignature(rawBody, signature);
    if (!valid) {
      console.warn("Signature verification failed");
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
      // Resolve userId
      let userId: string | null = null;
      const user = await getUserByWa(db, msg.from);

      if (user && user.status_verifikasi === "verified") {
        userId = user.id;
      } else if (isOwner(msg.from)) {
        userId = "da7b12d5-e9df-46cc-a4ba-f3a748c08412"; // Fallback to static admin UUID
      }

      if (!(await claimIncomingMessage(db, msg.messageId, userId || undefined))) {
        console.log(`Duplicate webhook message ignored: ${msg.messageId}`);
        continue;
      }

      // Mark as read (background, tidak await)
      markAsRead(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId).catch(
        () => {},
      );

      // Cek kode verifikasi WA (20 karakter) untuk SEMUA pengirim — bukan cuma yang belum
      // terverifikasi. Ini dibutuhkan supaya alur "Lupa Kata Sandi" (nomor sudah verified,
      // minta kode verifikasi ulang) juga bisa diproses lewat mekanisme yang sama persis.
      {
        const cleanText = (msg.text ?? "").trim().toUpperCase();
        let potentialCode = "";
        if (cleanText.length === 20 && /^[A-Z0-9]{20}$/.test(cleanText)) {
          potentialCode = cleanText;
        } else {
          const match = cleanText.match(/[A-Z0-9]{20}/);
          if (match) {
            potentialCode = match[0];
          }
        }

        if (potentialCode) {
          const verified = await verifyOtpViaChat(db, msg.from, potentialCode, msg.messageId);
          if (verified) {
            continue;
          }
        }
      }

      if (!userId) {
        // If not a verification code, send pendaftaran prompt
        const regPrompt = "Nomor WhatsApp Anda belum terdaftar di *KaslyAI*.\n\nSilakan lakukan pendaftaran terlebih dahulu melalui aplikasi web KaslyAI.";
        await sendWhatsAppMessage(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.from, regPrompt, msg.messageId);
        continue;
      }

      const isMedia = msg.type === "image" || msg.type === "audio";

      if (isMedia) {
        try {
          const { error } = await db.from("wa_media_queue").upsert(
            {
              wa_message_id: msg.messageId,
              user_id: userId,
              access_code: "wa_" + userId,
              wa_chat_id: msg.from,
              media_id: msg.mediaId,
              mime_type: msg.mimeType ?? (msg.type === "audio" ? "audio/ogg" : "image/jpeg"),
              media_kind: msg.type,
              caption: msg.caption ?? null,
            },
            { onConflict: "wa_message_id", ignoreDuplicates: true },
          );
          if (error) throw new Error(`Gagal memasukkan media ke batch: ${error.message}`);

          EdgeRuntime.waitUntil(
            withTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId, async () => {
              try {
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
                await processQueuedMediaBatch(db, GEMINI_API_KEYS, msg.from, userId);
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
                } catch {}
              }
            }),
          );
        } catch (e) {
          console.error("Error scheduling media:", e);
          try {
            await sendWhatsAppMessage(
              PHONE_NUMBER_ID,
              WA_ACCESS_TOKEN,
              msg.from,
              "Maaf, gagal memproses media Anda.",
              msg.messageId,
            );
          } catch {}
        }
      } else {
        await withTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId, async () => {
          try {
            if (Deno.env.get("WA_V2_ENABLED") === "true") {
              try {
                // @ts-ignore
                EdgeRuntime.waitUntil(
                  db.from("wa_logs").insert({
                    user_id: userId,
                    access_code: "wa_" + userId,
                    message: "Incoming Message metadata",
                    details: { messageId: msg.messageId, from: msg.from, type: msg.type, text: msg.text ?? msg.caption }
                  })
                );
              } catch {
                db.from("wa_logs").insert({
                  user_id: userId,
                  access_code: "wa_" + userId,
                  message: "Incoming Message metadata",
                  details: { messageId: msg.messageId, from: msg.from, type: msg.type, text: msg.text ?? msg.caption }
                }).catch(() => {});
              }

              const handled = await handleV2Message(db, GEMINI_API_KEYS, msg, userId);

              try {
                // @ts-ignore
                EdgeRuntime.waitUntil(
                  db.from("wa_logs").insert({
                    user_id: userId,
                    access_code: "wa_" + userId,
                    message: "V2 Router finished",
                    details: { messageId: msg.messageId, handled }
                  })
                );
              } catch {
                db.from("wa_logs").insert({
                  user_id: userId,
                  access_code: "wa_" + userId,
                  message: "V2 Router finished",
                  details: { messageId: msg.messageId, handled }
                }).catch(() => {});
              }

              if (handled) {
                return;
              }
            }

            // ── Cek apakah ini reply ke pesan bot ──────────────
            if (msg.contextId) {
              const { data: mapping } = await db
                .from("wa_message_transactions")
                .select("transaction_id")
                .eq("wa_message_id", msg.contextId)
                .single();

              if (mapping?.transaction_id) {
                await handleReplyToTransaction(db, GEMINI_API_KEYS, msg, mapping.transaction_id, userId);
                return;
              }

              const { data: pending } = await db
                .from("wa_pending_transactions")
                .select("id")
                .eq("wa_question_message_id", msg.contextId)
                .single();

              if (pending?.id) {
                await handlePendingNominalReply(db, GEMINI_API_KEYS, msg, pending.id, userId);
                return;
              }
            }

            // ── Route berdasarkan tipe pesan ────────────────────
            if (msg.type === "text") {
              await handleTextMessage(db, GEMINI_API_KEYS, msg, userId);
            }
          } catch (e) {
            console.error("Error processing message:", e);
            try {
              await db.from("wa_logs").insert({
                user_id: userId,
                access_code: "wa_" + userId,
                message: "CRITICAL_ERROR processing message",
                details: { messageId: msg.messageId, type: msg.type, error: String(e), stack: (e as Error)?.stack?.slice(0, 500) }
              });
            } catch {
              db.from("wa_logs").insert({
                user_id: userId,
                access_code: "wa_" + userId,
                message: "CRITICAL_ERROR processing message",
                details: { messageId: msg.messageId, type: msg.type, error: String(e) }
              }).catch(() => {});
            }
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
        });
      }
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
