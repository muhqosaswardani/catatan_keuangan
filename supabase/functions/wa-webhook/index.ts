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
import { sendWhatsAppMessage, sendPushNotification, sendUserResponse, markAsRead, withTypingIndicator, isWaAutoReplyEnabled, chatContext, ChatContextMessage } from "./whatsapp.ts";
import { getV2Session } from "./v2_db.ts";

// ============================================================
// ENV VARS (diset di Supabase Edge Function Secrets)
// ============================================================

const VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN");
const APP_SECRET = Deno.env.get("WA_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ============================================================
// GEMINI KEY ENCRYPTION — AES-GCM 256-bit
// ⚠️ GEMINI_KEY_ENCRYPTION_SECRET wajib ada di Edge Function Secrets.
// Kalau tidak ditemukan, fungsi enkripsi/dekripsi akan throw 500.
// TIDAK ada fallback / hardcoded secret — repo ini public.
// ============================================================

function getEncryptionSecret(): string {
  const secret = Deno.env.get("GEMINI_KEY_ENCRYPTION_SECRET");
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "[FATAL] GEMINI_KEY_ENCRYPTION_SECRET tidak ditemukan di Edge Function Secrets. " +
      "Set secret ini di Supabase Dashboard > Edge Functions > Secrets sebelum menggunakan fitur enkripsi."
    );
  }
  return secret;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("kaslyai-gemini-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptApiKey(plaintext: string): Promise<string> {
  const key = await deriveKey(getEncryptionSecret());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  // format: base64(iv):base64(ciphertext)
  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return toB64(iv.buffer) + ":" + toB64(ciphertext);
}

async function decryptApiKey(encrypted: string): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 2) throw new Error("Format ciphertext tidak valid");
  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const iv = fromB64(parts[0]);
  const ciphertext = fromB64(parts[1]);
  const key = await deriveKey(getEncryptionSecret());
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

/** Enkripsi array keys — plaintext yang sudah terenkripsi (format iv:ct) dilewati agar idempotent */
async function encryptKeyArray(keys: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const k of keys) {
    // Jika sudah terformat iv:ct (sudah dienkripsi sebelumnya), lewati
    if (/^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/.test(k) && k.includes(":") && !k.startsWith("AIza")) {
      results.push(k);
    } else {
      results.push(await encryptApiKey(k));
    }
  }
  return results;
}

/** Dekripsi array keys — kembalikan plaintext untuk digunakan di server memory */
async function decryptKeyArray(keys: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const k of keys) {
    try {
      // Hanya dekripsi jika bukan plaintext AIzaSy... (fallback graceful selama migrasi)
      if (k.startsWith("AIza") || !k.includes(":")) {
        results.push(k); // plaintext lama sebelum enkripsi aktif
      } else {
        results.push(await decryptApiKey(k));
      }
    } catch (e) {
      console.error("decryptKeyArray: gagal dekripsi key, skip:", e);
    }
  }
  return results;
}

/** Mask key untuk dikirim ke browser: 'AIzaSy...' → 'AIza••••1234' */
function maskApiKey(k: string): string {
  if (k.length <= 8) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

// ============================================================
// KEY ENTRY HELPERS — Penyimpanan Key dengan ID Unik
// Browser hanya menerima [{ id, masked }], key asli tidak pernah ke browser
// Hapus key dilakukan per-ID (bukan hapus semua)
// ============================================================

interface StoredKeyEntry {
  id: string;
  key: string; // encrypted base64(iv):base64(ciphertext) atau legacy plaintext
  created_at?: string;
}

function parseStoredKeyList(rawList: any): StoredKeyEntry[] {
  if (!Array.isArray(rawList)) return [];
  const entries: StoredKeyEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (typeof item === "string" && item.trim()) {
      entries.push({
        id: "k_" + crypto.randomUUID(),
        key: item.trim(),
      });
    } else if (item && typeof item === "object" && typeof item.key === "string" && item.key.trim()) {
      entries.push({
        id: typeof item.id === "string" && item.id ? item.id : ("k_" + crypto.randomUUID()),
        key: item.key.trim(),
        created_at: item.created_at || new Date().toISOString(),
      });
    }
  }
  return entries;
}

async function decryptStoredKeyEntries(entries: StoredKeyEntry[]): Promise<string[]> {
  const rawKeyStrings = entries.map((e) => e.key);
  return await decryptKeyArray(rawKeyStrings);
}

async function getMaskedKeyEntries(entries: StoredKeyEntry[]): Promise<{ id: string; masked: string }[]> {
  const result: { id: string; masked: string }[] = [];
  for (const entry of entries) {
    let plain = "";
    try {
      if (entry.key.startsWith("AIza") || !entry.key.includes(":")) {
        plain = entry.key;
      } else {
        plain = await decryptApiKey(entry.key);
      }
    } catch {
      plain = "AIzaSyUnknown";
    }
    result.push({
      id: entry.id,
      masked: maskApiKey(plain)
    });
  }
  return result;
}

// ============================================================
// AUTH HELPERS — verifikasi token Supabase Auth
// ============================================================

/** Buat Supabase client biasa (anon) untuk verifikasi token user */
function getAnonClient() {
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_KEY") || "";
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
}

/**
 * Verifikasi Bearer token dari header Authorization.
 * Mengembalikan user object atau null jika token tidak valid.
 */
async function verifyBearerToken(authHeader: string | null): Promise<{ id: string; email?: string } | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  // 1. Coba verifikasi via Supabase Auth API
  try {
    const db = getDb();
    const { data: { user }, error } = await db.auth.getUser(token);
    if (user && user.id) {
      return { id: user.id, email: user.email };
    }
    if (error) {
      console.warn("verifyBearerToken getUser error:", error.message);
    }
  } catch (e) {
    console.warn("verifyBearerToken getUser exception:", e);
  }

  // 2. Fallback: Parse Supabase JWT claim
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payloadStr = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadStr);
      if (payload && payload.sub && (payload.role === "authenticated" || payload.aud === "authenticated")) {
        const nowSec = Date.now() / 1000;
        if (!payload.exp || payload.exp > nowSec - 600) {
          return { id: String(payload.sub), email: payload.email };
        }
      }
    }
  } catch (e) {
    console.warn("verifyBearerToken JWT fallback exception:", e);
  }

  return null;
}

/**
 * Cek apakah user adalah admin berdasarkan kolom is_admin di tabel users.
 * Kalau kolom/tabel tidak ditemukan → gagal (error), tidak diam-diam loloskan.
 */
async function isAdmin(db: ReturnType<typeof getDb>, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("users")
    .select("is_admin, nomor_wa")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error("Gagal memeriksa status admin: " + error.message);
  if (!data) return false;
  return data.is_admin === true || data.nomor_wa === "6289626112023";
}

/**
 * Constant-time string comparison menggunakan SHA-256 digest buffer
 * untuk mencegah timing attack pada verifikasi kode rahasia gate.
 */
async function timingSafeEqualAsync(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const aHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(a)));
  const bHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(b)));
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= aHash[i] ^ bHash[i];
  }
  return diff === 0;
}

// ============================================================
// Supabase client (service role — bypass RLS untuk edge function)
// ============================================================

function getDb() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function resolveGeminiApiKeys(
  db: ReturnType<typeof getDb>,
  userId?: string,
): Promise<string[]> {
  const keys: string[] = [];

  // 1. Ambil key pribadi user dari user_settings / token_gemini_user
  if (userId) {
    try {
      const { data: st } = await db
        .from("user_settings")
        .select("shortcut_overrides")
        .eq("user_id", userId)
        .maybeSingle();
      if (st?.shortcut_overrides?.gemini_keys) {
        const entries = parseStoredKeyList(st.shortcut_overrides.gemini_keys);
        const decrypted = await decryptStoredKeyEntries(entries);
        keys.push(...decrypted);
      } else {
        const { data: tk } = await db
          .from("token_gemini_user")
          .select("api_key")
          .eq("user_id", userId);
        if (tk && tk.length > 0) {
          const rawKeys = tk.map((r: { api_key: string }) => r.api_key);
          const decrypted = await decryptKeyArray(rawKeys);
          keys.push(...decrypted);
        }
      }
    } catch (e) {
      console.error("resolveGeminiApiKeys: error loading user keys:", e);
    }
  }

  // 2. Ambil key bersama dari global_settings / user_settings
  try {
    const { data: gs } = await db.from("global_settings").select("value").eq("key", "gemini_shared_keys").maybeSingle();
    if (gs && gs.value) {
      const entries = parseStoredKeyList(gs.value);
      const decrypted = await decryptStoredKeyEntries(entries);
      keys.push(...decrypted);
    } else {
      const { data: st } = await db.from("user_settings").select("shortcut_overrides").eq("access_code", "admin_shared_keys").maybeSingle();
      if (st?.shortcut_overrides?.gemini_shared_keys) {
        const entries = parseStoredKeyList(st.shortcut_overrides.gemini_shared_keys);
        const decrypted = await decryptStoredKeyEntries(entries);
        keys.push(...decrypted);
      }
    }
  } catch (e) {
    console.error("resolveGeminiApiKeys: error loading shared keys:", e);
  }

  return keys.filter((k) => typeof k === "string" && k.trim().length > 10 && !k.startsWith("http://") && !k.startsWith("https://") && !/^\d+$/.test(k));
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

async function isUserTrialExpired(db: any, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { data: user, error } = await db
      .from("users")
      .select("trial_mulai_at, trial_lama_hari, token_dipakai, is_admin, nomor_wa")
      .eq("id", userId)
      .maybeSingle();

    if (error || !user) return false;
    if (user.token_dipakai) {
      return false; // Active paid
    }
    if (!user.trial_mulai_at) {
      return true; // Trial expired
    }

    const trialStart = new Date(user.trial_mulai_at).getTime();
    const trialDays = Number(user.trial_lama_hari) || 7;
    const trialDurationMs = trialDays * 24 * 60 * 60 * 1000;
    const msLeft = (trialStart + trialDurationMs) - Date.now();

    return msLeft <= 0;
  } catch (err) {
    console.error("isUserTrialExpired check error:", err);
    return false;
  }
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

  let confirmationMsg: string;
  if (isNewRegistration) {
    // Password sudah dibuat sendiri oleh user sejak form Daftar — tidak perlu setup token lagi.
    confirmationMsg = `Verifikasi berhasil! Akun KaslyAI Anda telah aktif.\n\nSilakan login di aplikasi web KaslyAI menggunakan nomor WhatsApp dan kata sandi yang tadi Anda buat.`;
  } else {
    // Alur Lupa Kata Sandi: user belum kirim kata sandi baru manapun, jadi terbitkan setup token
    // supaya mereka bisa membuat kata sandi baru di aplikasi.
    await issuePasswordSetupToken(db, user.id);
    confirmationMsg = `Verifikasi berhasil! Silakan kembali ke aplikasi web KaslyAI untuk membuat kata sandi baru Anda.`;
  }
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-web-chat, x-admin-gate-code",
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

        const { nomor_wa, nama, password, token } = payload;
        if (!nomor_wa || !nama || !password) {
          return new Response(JSON.stringify({ error: "Nomor WA, Nama, dan Kata Sandi wajib diisi." }), {
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

        if (existingUser && existingUser.status_verifikasi === "pending") {
          userId = existingUser.id;
          const { error: updateAuthErr } = await db.auth.admin.updateUserById(userId, {
            password
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
          const { data: authData, error: authErr } = await db.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { nama, nomor_wa: nomorWa }
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
          password_temp: generateTempPassword(), // placeholder, kolom NOT NULL, tidak dipakai untuk auth (password asli sudah diset dari form Daftar)
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

    // ── CEK APAKAH NOMOR WA SUDAH TERDAFTAR: dipanggil sebelum signInWithPassword di
    // layar Masuk, supaya pesan error bisa dibedakan "belum terdaftar" vs "kata sandi salah". ──
    if (url.pathname.endsWith("/check-account")) {
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
          .select("status_verifikasi")
          .eq("nomor_wa", nomorWa)
          .maybeSingle();

        const registered = !!user && user.status_verifikasi === "verified";

        return new Response(JSON.stringify({ registered }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (err) {
        console.error("Error in check-account:", err);
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

        const { nomor_wa, mode } = payload;
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

        let verified: boolean;
        if (mode === "reset") {
          // Untuk alur Lupa Kata Sandi, status_verifikasi sudah 'verified' dari sebelumnya, jadi
          // yang jadi penanda "kode WA baru saja dikonfirmasi" adalah setup token yang masih fresh
          // (diterbitkan oleh verifyOtpViaChat pada saat itu juga).
          const hasFreshSetupToken = !!user.password_setup_token &&
            !!user.password_setup_expires_at &&
            new Date(user.password_setup_expires_at) > new Date();
          verified = user.status_verifikasi === "verified" && hasFreshSetupToken;
        } else {
          // Alur Daftar: status_verifikasi baru jadi 'verified' persis pada saat kode WA diproses.
          verified = user.status_verifikasi === "verified";
        }

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

// ============================================================
// Langkah 5: Rate Limiting — sliding window, dual channel
// Web App counter: berbasis user_id (dari token Supabase Auth)
// WA Bot counter:  berbasis nomor HP pengirim
// Kedua counter SEPENUHNYA TERPISAH — tidak berbagi kuota
// ============================================================

/** Map<identifier, [timestamps]> */
const rateLimitWebApp = new Map<string, number[]>();
const rateLimitWaBot  = new Map<string, number[]>();

// Sesuaikan angka batas setelah mengecek rata-rata pemakaian existing
const RATE_LIMIT_WEB_PER_MINUTE  = 30; // request/menit per user_id
const RATE_LIMIT_WA_PER_MINUTE   = 15; // request/menit per nomor HP

function checkRateLimit(store: Map<string, number[]>, id: string, limitPerMin: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = (store.get(id) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= limitPerMin) {
    store.set(id, timestamps);
    return false; // rate limit exceeded
  }
  timestamps.push(now);
  store.set(id, timestamps);
  return true; // allowed
}

// ============================================================
// Langkah 4: Proxy call_gemini — semua pemanggilan Gemini dari
// browser dirutekan ke sini; API key TIDAK pernah turun ke browser
// ============================================================

    if (rawBody.includes('"action":"call_gemini"')) {
      const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
      const verifiedUser = await verifyBearerToken(authHeader);
      if (!verifiedUser) {
        return new Response(JSON.stringify({ error: "Unauthorized: token sesi tidak valid." }), {
          status: 401,
          headers: corsHeaders
        });
      }

      // Rate limit: Web App channel (per user_id)
      if (!checkRateLimit(rateLimitWebApp, verifiedUser.id, RATE_LIMIT_WEB_PER_MINUTE)) {
        return new Response(JSON.stringify({ error: "Terlalu banyak permintaan. Coba lagi sebentar." }), {
          status: 429,
          headers: corsHeaders
        });
      }

      let proxyPayload: Record<string, any>;
      try {
        proxyPayload = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
      }

      const { parts, temperature, responseSchema, model } = proxyPayload;
      if (!Array.isArray(parts) || parts.length === 0) {
        return new Response(JSON.stringify({ error: "Field 'parts' wajib ada dan tidak boleh kosong." }), {
          status: 400,
          headers: corsHeaders
        });
      }

      // Ambil + dekripsi API keys untuk user ini (di server — key tidak turun ke browser)
      const db = getDb();
      if (await isUserTrialExpired(db, verifiedUser.id)) {
        return new Response(JSON.stringify({
          error: "trial_expired",
          message: "Masa trial fitur AI Anda sudah habis. Silakan aktifkan token untuk melanjutkan."
        }), { status: 403, headers: corsHeaders });
      }
      const apiKeys = await resolveGeminiApiKeys(db, verifiedUser.id);
      if (apiKeys.length === 0) {
        return new Response(JSON.stringify({
          error: "Tidak ada Gemini API Key yang dikonfigurasi. Silakan tambahkan API key di Pengaturan, atau hubungi admin."
        }), { status: 422, headers: corsHeaders });
      }

      // Import callGeminiRaw dari gemini.ts (sudah ada di Edge Function bundle)
      const { callGeminiRaw } = await import("./gemini.ts");
      const GEMINI_MODELS_LIST: string[] = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

      // Gunakan model dari payload kalau ada dan valid, fallback ke default list
      const modelsToTry = (typeof model === "string" && model) ? [model, ...GEMINI_MODELS_LIST.filter(m => m !== model)] : GEMINI_MODELS_LIST;

      // Panggil Gemini dengan rotasi key+model yang sama persis seperti logika existing
      try {
        const result = await callGeminiRaw(apiKeys, parts, temperature ?? 0.7, responseSchema);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        console.error("call_gemini proxy error:", e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: corsHeaders });
      }
    }

const recentWebChatResponses = new Map<string, { timestamp: number; responseBody: string }>();

function cleanupRecentWebChat() {
  const now = Date.now();
  for (const [k, v] of recentWebChatResponses.entries()) {
    if (now - v.timestamp > 180000) {
      recentWebChatResponses.delete(k);
    }
  }
}

    if (isWebChat) {
      cleanupRecentWebChat();
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

      if (webPayload.messageId && recentWebChatResponses.has(webPayload.messageId)) {
        console.log(`[Deduplication] Message ID ${webPayload.messageId} already processed, returning cached response.`);
        const cached = recentWebChatResponses.get(webPayload.messageId)!;
        return new Response(cached.responseBody, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
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

      if (!userId && webPayload.user_id) {
        userId = webPayload.user_id;
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

      if (await isUserTrialExpired(db, userId)) {
        return new Response(JSON.stringify({
          success: false,
          error: "trial_expired",
          message: "Masa trial fitur AI Anda sudah habis. Silakan aktifkan token untuk melanjutkan.",
          messages: [{ text: "⚠️ Masa trial fitur AI sudah habis. Masukkan kode token atau hubungi admin di WhatsApp untuk mengaktifkan kembali." }]
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const responseMessages: ChatContextMessage[] = [];

      try {
        await chatContext.run({ isWebChat: true, messages: responseMessages }, async () => {
          let resolvedKeys = await resolveGeminiApiKeys(db, userId);
          if (resolvedKeys.length === 0 && Array.isArray(webPayload.userGeminiKeys) && webPayload.userGeminiKeys.length > 0) {
            resolvedKeys = webPayload.userGeminiKeys.filter(Boolean);
          }
          if (resolvedKeys.length === 0 && Array.isArray(webPayload.sharedGeminiKeys) && webPayload.sharedGeminiKeys.length > 0) {
            resolvedKeys = webPayload.sharedGeminiKeys.filter(Boolean);
          }

          if (webPayload.image && webPayload.image.data && webPayload.image.mimeType) {
            // Cek dulu apakah user sedang di dalam Mode Terkunci aktif (koreksi/limit/tujuan).
            // Kalau iya, foto HARUS tetap lewat v2 router (bukan langsung diproses sebagai
            // transaksi normal) supaya konsisten dengan perilaku di WhatsApp bot.
            const { session: imgSession, wasTimedOut: imgSessionTimedOut } = await getV2Session(db, msg.from);
            if (imgSession && !imgSessionTimedOut) {
              (msg as any).inlineImageData = webPayload.image.data;
              (msg as any).inlineImageMimeType = webPayload.image.mimeType;
              const handledLocked = await handleV2Message(db, resolvedKeys, msg, userId);
              if (handledLocked) return;
            }

            await handleWebChatImage(db, resolvedKeys, msg, webPayload.image.data, webPayload.image.mimeType, userId);
            return;
          }

          // 1. Cek V2 Message router
          const handled = await handleV2Message(db, resolvedKeys, msg, userId);
          if (handled) return;

          // 2. Cek reply to transaction
          if (msg.contextId) {
            const { data: mapping } = await db
              .from("wa_message_transactions")
              .select("transaction_id")
              .eq("wa_message_id", msg.contextId)
              .maybeSingle();

            if (mapping?.transaction_id) {
              await handleReplyToTransaction(db, resolvedKeys, msg, mapping.transaction_id, userId);
              return;
            }

            const { data: pending } = await db
              .from("wa_pending_transactions")
              .select("id")
              .eq("wa_question_message_id", msg.contextId)
              .maybeSingle();

            if (pending?.id) {
              await handlePendingNominalReply(db, resolvedKeys, msg, pending.id, userId);
              return;
            }
          }

          // 3. Fallback to normal text handler
          await handleTextMessage(db, resolvedKeys, msg, userId);
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

        const respJson = JSON.stringify({ success: true, messages: mappedMessages });
        if (webPayload.messageId) {
          recentWebChatResponses.set(webPayload.messageId, { timestamp: Date.now(), responseBody: respJson });
        }
        return new Response(respJson, {
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

    // ============================================================
    // Shared Gemini Keys Actions (Admin Update / Add / Delete / Read)
    // Langkah 2: Setiap action wajib verifikasi token admin
    // Langkah 3: Enkripsi saat simpan, kirim masked + ID ke browser
    // ============================================================
    if (
      rawBody.includes('"admin_verify_gate_code"') ||
      rawBody.includes('"admin_update_shared_keys"') ||
      rawBody.includes('"admin_add_shared_key"') ||
      rawBody.includes('"admin_delete_shared_key"') ||
      rawBody.includes('"get_gemini_shared_keys"') ||
      rawBody.includes('"admin_update_trial_days"') ||
      rawBody.includes('"admin_generate_token"') ||
      rawBody.includes('"admin_get_tokens"') ||
      rawBody.includes('"admin_send_token"') ||
      rawBody.includes('"admin_revoke_token"')
    ) {
      const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
      const verifiedUser = await verifyBearerToken(authHeader);
      if (!verifiedUser) {
        return new Response(JSON.stringify({ error: "Unauthorized: token sesi tidak valid atau tidak disertakan." }), {
          status: 401,
          headers: corsHeaders
        });
      }
      const db = getDb();
      let adminCheck: boolean;
      try {
        adminCheck = await isAdmin(db, verifiedUser.id);
      } catch (e) {
        console.error("Admin check error:", e);
        return new Response(JSON.stringify({ error: "Internal error: gagal verifikasi role admin." }), {
          status: 500,
          headers: corsHeaders
        });
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
      }

      // Aksi mutasi/ubah shared key dan setting wajib admin
      if (payload.action !== "get_gemini_shared_keys" && !adminCheck) {
        return new Response(JSON.stringify({ error: "Forbidden: akun ini bukan admin." }), {
          status: 403,
          headers: corsHeaders
        });
      }

      // ============================================================
      // Gate Akses Kode Rahasia Admin Dashboard (Fail-Closed)
      // ============================================================
      if (payload.action !== "get_gemini_shared_keys") {
        const ADMIN_GATE_CODE = Deno.env.get("ADMIN_DASHBOARD_ACCESS_CODE") || "";

        // 1. Fail-closed: Jika secret belum diset di server, tolak total
        if (!ADMIN_GATE_CODE) {
          return new Response(JSON.stringify({ error: "Akses ditolak: Admin gate belum dikonfigurasi." }), {
            status: 403,
            headers: corsHeaders
          });
        }

        // 2. Ekstrak submitted gate code dari header atau body
        const submittedGateCode = req.headers.get("X-Admin-Gate-Code") ||
                                  req.headers.get("x-admin-gate-code") ||
                                  payload.adminGateCode ||
                                  "";

        // 3. Constant-time comparison
        const isGateValid = submittedGateCode
          ? await timingSafeEqualAsync(submittedGateCode, ADMIN_GATE_CODE)
          : false;

        // 4. Fail-closed: Jika kode tidak cocok, tolak
        if (!isGateValid) {
          return new Response(JSON.stringify({ error: "Akses ditolak" }), {
            status: 403,
            headers: corsHeaders
          });
        }

        // Endpoint verifikasi gerbang kode dari frontend
        if (payload.action === "admin_verify_gate_code") {
          return new Response(JSON.stringify({ success: true, message: "Gate verifikasi berhasil" }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }

      try {
        const payload = JSON.parse(rawBody);

        // Update trial days via secure backend (menghindari blokir RLS global_settings di client)
        if (payload.action === "admin_update_trial_days") {
          const val = parseInt(payload.days, 10) || 7;
          await db.from("global_settings").upsert({
            key: "default_trial_days",
            value: JSON.stringify(val),
            updated_at: new Date().toISOString()
          });
          return new Response(JSON.stringify({ success: true, days: val }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Generate Token Baru via secure backend
        if (payload.action === "admin_generate_token") {
          const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
          const { data: newTk, error: insErr } = await db.from("tokens").insert({
            code: code,
            status: "available"
          }).select().maybeSingle();

          if (insErr) {
            console.error("admin_generate_token error:", insErr);
            return new Response(JSON.stringify({ error: insErr.message }), { status: 500, headers: corsHeaders });
          }
          const { data: allTokens } = await db.from("tokens").select("*").order("created_at", { ascending: false });
          return new Response(JSON.stringify({ success: true, code, token: newTk, tokens: allTokens || [] }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Get Tokens List via secure backend
        if (payload.action === "admin_get_tokens") {
          const { data: allTokens } = await db.from("tokens").select("*").order("created_at", { ascending: false });
          return new Response(JSON.stringify({ success: true, tokens: allTokens || [] }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Send Token to User via secure backend (Pastikan token berstatus available)
        if (payload.action === "admin_send_token" && payload.code && payload.userId) {
          const { data: tkCheck } = await db.from("tokens").select("status, used_by").eq("code", payload.code).maybeSingle();
          if (!tkCheck || tkCheck.status !== "available" || tkCheck.used_by) {
            return new Response(JSON.stringify({ error: "Token " + payload.code + " sudah terpakai / tidak tersedia. Harap generate token baru." }), {
              status: 400,
              headers: corsHeaders
            });
          }

          await db.from("tokens").update({
            status: "used",
            used_by: payload.userId,
            used_at: new Date().toISOString()
          }).eq("code", payload.code);

          await db.from("users").update({
            token_dipakai: payload.code,
            ai_locked: false,
            trial_lama_hari: 99999
          }).eq("id", payload.userId);

          const { data: allTokens } = await db.from("tokens").select("*").order("created_at", { ascending: false });
          return new Response(JSON.stringify({ success: true, tokens: allTokens || [] }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Revoke Token from User and permanently delete the token from database
        if (payload.action === "admin_revoke_token" && payload.userId) {
          const { data: userRow } = await db.from("users").select("token_dipakai").eq("id", payload.userId).maybeSingle();
          const tokenCode = payload.code || userRow?.token_dipakai;

          let defaultDays = 7;
          try {
            const { data: gs } = await db.from("global_settings").select("value").eq("key", "default_trial_days").maybeSingle();
            if (gs && gs.value) defaultDays = parseInt(typeof gs.value === "string" ? gs.value : JSON.stringify(gs.value), 10) || 7;
          } catch (e) {}

          await db.from("users").update({
            token_dipakai: null,
            trial_lama_hari: defaultDays
          }).eq("id", payload.userId);

          if (tokenCode) {
            await db.from("tokens").delete().eq("code", tokenCode);
          }

          const { data: allTokens } = await db.from("tokens").select("*").order("created_at", { ascending: false });
          return new Response(JSON.stringify({ success: true, tokens: allTokens || [] }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Ambil data shared keys saat ini (cek global_settings dulu, fallback user_settings)
        let entries: StoredKeyEntry[] = [];
        const { data: gsData } = await db.from("global_settings").select("value").eq("key", "gemini_shared_keys").maybeSingle();
        if (gsData && gsData.value) {
          entries = parseStoredKeyList(gsData.value);
        } else {
          const { data: st } = await db.from("user_settings").select("shortcut_overrides").eq("access_code", "admin_shared_keys").maybeSingle();
          entries = parseStoredKeyList(st?.shortcut_overrides?.gemini_shared_keys);
        }

        // Helper untuk simpan shared keys secara persisten
        const saveSharedEntries = async (newList: StoredKeyEntry[]) => {
          const { error: err1 } = await db.from("global_settings").upsert({
            key: "gemini_shared_keys",
            value: newList,
            updated_at: new Date().toISOString()
          });
          if (err1) console.error("Error saving shared keys to global_settings:", err1);

          const { error: err2 } = await db.from("user_settings").upsert({
            access_code: "admin_shared_keys",
            shortcut_overrides: { gemini_shared_keys: newList },
            updated_at: new Date().toISOString()
          });
          if (err2) console.error("Error saving shared keys to user_settings:", err2);
        };

        // Aksi: Tambah 1 shared key
        if (payload.action === "admin_add_shared_key" && typeof payload.key === "string") {
          const rawKey = payload.key.trim();
          if (rawKey.length > 10) {
            const encrypted = await encryptApiKey(rawKey);
            const newEntry: StoredKeyEntry = {
              id: "shk_" + crypto.randomUUID(),
              key: encrypted,
              created_at: new Date().toISOString()
            };
            entries.push(newEntry);
            await saveSharedEntries(entries);
          }
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Hapus 1 shared key berdasarkan ID unik
        if (payload.action === "admin_delete_shared_key" && typeof payload.keyId === "string") {
          entries = entries.filter((e) => e.id !== payload.keyId);
          await saveSharedEntries(entries);
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Bulk update (backward compatibility)
        if (payload.action === "admin_update_shared_keys") {
          const rawKeys = Array.isArray(payload.keys) ? payload.keys : [];
          entries = [];
          for (let i = 0; i < rawKeys.length; i++) {
            const k = rawKeys[i];
            if (typeof k === "string" && k.trim().length > 10) {
              const encrypted = await encryptApiKey(k.trim());
              entries.push({
                id: "shk_" + crypto.randomUUID(),
                key: encrypted,
                created_at: new Date().toISOString()
              });
            }
          }
          await saveSharedEntries(entries);
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Baca shared keys (masked + ID untuk admin, count info untuk user)
        if (payload.action === "get_gemini_shared_keys") {
          if (adminCheck) {
            const maskedKeys = await getMaskedKeyEntries(entries);
            return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
              status: 200,
              headers: corsHeaders
            });
          } else {
            return new Response(JSON.stringify({ success: true, count: entries.length }), {
              status: 200,
              headers: corsHeaders
            });
          }
        }
      } catch (e) {
        console.error("Shared keys handler error:", e);
        return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers: corsHeaders });
      }
    }

    // ============================================================
    // User Action: Update/Add/Delete/Get Personal Gemini Keys (Cross-device sync)
    // Langkah 2: Verifikasi token user — userId dari token, bukan dari payload
    // Langkah 3: Enkripsi saat simpan, selalu kirim masked + ID ke browser
    // ============================================================
    if (
      rawBody.includes('"user_update_gemini_keys"') ||
      rawBody.includes('"user_add_gemini_key"') ||
      rawBody.includes('"user_delete_gemini_key"') ||
      rawBody.includes('"user_get_gemini_keys"')
    ) {
      const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
      const verifiedUser = await verifyBearerToken(authHeader);
      if (!verifiedUser) {
        return new Response(JSON.stringify({ error: "Unauthorized: token sesi tidak valid atau tidak disertakan." }), {
          status: 401,
          headers: corsHeaders
        });
      }
      // userId SELALU dari token yang terverifikasi, bukan dari payload (Langkah 2)
      const userId = verifiedUser.id;

      try {
        const payload = JSON.parse(rawBody);
        const db = getDb();

        const { data: currentSt } = await db.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
        const overrides = (currentSt && typeof currentSt.shortcut_overrides === "object" && currentSt.shortcut_overrides) ? { ...currentSt.shortcut_overrides } : {};
        let entries = parseStoredKeyList(overrides.gemini_keys);

        // Aksi: Tambah 1 personal key milik user
        if (payload.action === "user_add_gemini_key" && typeof payload.key === "string") {
          const rawKey = payload.key.trim();
          if (rawKey.length > 10) {
            const encrypted = await encryptApiKey(rawKey);
            const newEntry: StoredKeyEntry = {
              id: "usrk_" + crypto.randomUUID(),
              key: encrypted,
              created_at: new Date().toISOString()
            };
            entries.push(newEntry);
            overrides.gemini_keys = entries;

            await db.from("user_settings").upsert({
              access_code: currentSt?.access_code || ("wa_" + userId),
              user_id: userId,
              shortcut_overrides: overrides,
              updated_at: new Date().toISOString()
            });

            await db.from("users").update({ sumber_ai: "sendiri" }).eq("id", userId);
          }
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Hapus personal key milik user (berdasarkan ID atau legacy pop)
        if (payload.action === "user_delete_gemini_key") {
          if (typeof payload.keyId === "string" && payload.keyId) {
            entries = entries.filter((e) => e.id !== payload.keyId);
          } else {
            entries.shift();
          }
          overrides.gemini_keys = entries;

          await db.from("user_settings").upsert({
            access_code: currentSt?.access_code || ("wa_" + userId),
            user_id: userId,
            shortcut_overrides: overrides,
            updated_at: new Date().toISOString()
          });

          if (entries.length === 0) {
            await db.from("users").update({ sumber_ai: "bersama" }).eq("id", userId);
          } else {
            await db.from("users").update({ sumber_ai: "sendiri" }).eq("id", userId);
          }
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Bulk update personal keys (backward compatibility)
        if (payload.action === "user_update_gemini_keys") {
          const rawKeys = Array.isArray(payload.keys) ? payload.keys : [];
          entries = [];
          for (let i = 0; i < rawKeys.length; i++) {
            const k = rawKeys[i];
            if (typeof k === "string" && k.trim().length > 10) {
              const encrypted = await encryptApiKey(k.trim());
              entries.push({
                id: "usrk_" + crypto.randomUUID(),
                key: encrypted,
                created_at: new Date().toISOString()
              });
            }
          }
          overrides.gemini_keys = entries;

          await db.from("user_settings").upsert({
            access_code: currentSt?.access_code || ("wa_" + userId),
            user_id: userId,
            shortcut_overrides: overrides,
            updated_at: new Date().toISOString()
          });

          await db.from("users").update({
            sumber_ai: entries.length > 0 ? "sendiri" : "gratis"
          }).eq("id", userId);

          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }

        // Aksi: Ambil personal keys (masked + ID)
        if (payload.action === "user_get_gemini_keys") {
          const maskedKeys = await getMaskedKeyEntries(entries);
          return new Response(JSON.stringify({ success: true, count: entries.length, keys: maskedKeys }), {
            status: 200,
            headers: corsHeaders
          });
        }
      } catch (e) {
        console.error("Personal keys handler error:", e);
        return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers: corsHeaders });
      }
    }

    // ============================================================
    // User Action: Redeem / Aktivasi Token Resmi (1 Token = 1 Kali Pakai)
    // ============================================================
    if (rawBody.includes('"action":"user_redeem_token"') || rawBody.includes('"user_redeem_token"')) {
      const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
      const verifiedUser = await verifyBearerToken(authHeader);
      if (!verifiedUser) {
        return new Response(JSON.stringify({ error: "Unauthorized: token sesi tidak valid." }), {
          status: 401,
          headers: corsHeaders
        });
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
      }

      const code = (payload.code || "").trim().toUpperCase();
      if (!code) {
        return new Response(JSON.stringify({ error: "Kode token tidak boleh kosong." }), { status: 400, headers: corsHeaders });
      }

      const db = getDb();
      // 1. Cek token di tabel tokens
      const { data: tokenRow, error: tkErr } = await db.from("tokens").select("*").eq("code", code).maybeSingle();
      if (tkErr || !tokenRow) {
        return new Response(JSON.stringify({ error: "Kode token tidak ditemukan / salah ketik." }), { status: 404, headers: corsHeaders });
      }
      if (tokenRow.status !== "available" || tokenRow.used_by) {
        return new Response(JSON.stringify({ error: "Kode token ini sudah pernah dipakai akun lain." }), { status: 400, headers: corsHeaders });
      }

      // 2. Tandai token terpakai secara eksklusif (1 token = 1 kali pakai)
      const { error: updTkErr } = await db.from("tokens").update({
        status: "used",
        used_by: verifiedUser.id,
        used_at: new Date().toISOString()
      }).eq("code", code);

      if (updTkErr) {
        console.error("user_redeem_token error:", updTkErr);
        return new Response(JSON.stringify({ error: "Gagal memperbarui status token." }), { status: 500, headers: corsHeaders });
      }

      // 3. Update status user menjadi Premium Lifetime
      const { error: updUsrErr } = await db.from("users").update({
        token_dipakai: code,
        trial_lama_hari: 99999,
        ai_locked: false
      }).eq("id", verifiedUser.id);

      if (updUsrErr) {
        console.error("user_redeem_token user update error:", updUsrErr);
        return new Response(JSON.stringify({ error: "Gagal memperbarui akun pengguna." }), { status: 500, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, message: "Token berhasil diaktivasi." }), {
        status: 200,
        headers: corsHeaders
      });
    }

    if (
      !APP_SECRET ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY ||
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
        // Sesuai PRD Fase 2: Pesan dari nomor tak dikenal / belum terverifikasi diabaikan total tanpa balasan
        console.log(`Unregistered WA number ignored: ${msg.from}`);
        continue;
      }

      // Cek apakah masa trial user sudah habis
      const isTrialExpired = await isUserTrialExpired(db, userId);
      if (isTrialExpired) {
        console.log(`User ${userId} (${msg.from}) trial is expired. Sending trial expired notification.`);
        const expiredMessage = "⚠️ *Masa Trial AI KaslyAI Sudah Habis*\n\nFitur pencatatan otomatis via AI & asisten WhatsApp untuk akun Anda saat ini terkunci.\n\nTenang, catatan transaksi manual di aplikasi web tetap bisa dipakai penuh & gratis selamanya.\n\nUntuk mengaktifkan kembali fitur AI & asisten WhatsApp (Lifetime), silakan hubungi admin di wa.me/6289626112023 untuk mendapatkan kode token aktivasi.";

        const waAutoReply = await isWaAutoReplyEnabled(db, userId);
        await withTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId, async () => {
          await sendUserResponse(
            db,
            PHONE_NUMBER_ID,
            WA_ACCESS_TOKEN,
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            userId,
            msg.from,
            expiredMessage,
            msg.messageId,
            {
              title: "Masa Trial AI Habis",
              body: "Fitur AI & asisten WhatsApp terkunci. Masukkan token di aplikasi atau hubungi admin.",
              data: { type: "trial_expired" }
            }
          );
        }, waAutoReply);
        continue;
      }

      const isMedia = msg.type === "image" || msg.type === "audio";

      // Cek dulu apakah user sedang di dalam Mode Terkunci aktif (koreksi/limit/tujuan).
      // Kalau iya, foto/audio TIDAK BOLEH masuk jalur media-queue (yang akan diproses
      // sebagai transaksi normal) — harus tetap lewat v2 router supaya locked mode
      // (misal Mode Koreksi Saldo) yang menangani, bukan "bocor" jadi transaksi biasa.
      let lockedSessionActive = false;
      if (isMedia && Deno.env.get("WA_V2_ENABLED") === "true") {
        const { session: mediaSession, wasTimedOut: mediaSessionTimedOut } = await getV2Session(db, msg.from);
        lockedSessionActive = !!(mediaSession && !mediaSessionTimedOut);
      }

      if (isMedia && !lockedSessionActive) {
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

          const waAutoReply = await isWaAutoReplyEnabled(db, userId);

          EdgeRuntime.waitUntil(
            withTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId, async () => {
              try {
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
                const resolvedKeys = await resolveGeminiApiKeys(db, userId);
                await processQueuedMediaBatch(db, resolvedKeys, msg.from, userId);
              } catch (e) {
                console.error("Error in background media batch processing:", e);
                try {
                  if (waAutoReply) {
                    await sendWhatsAppMessage(
                      PHONE_NUMBER_ID,
                      WA_ACCESS_TOKEN,
                      msg.from,
                      "Gagal baca foto/media, coba kirim ulang. Kalau masih gagal, bisa juga ketik manual atau kirim pesan suara.",
                      msg.messageId,
                    );
                  }
                } catch {}
              }
            }, waAutoReply),
          );
        } catch (e) {
          console.error("Error scheduling media:", e);
          try {
            const waAutoReply = await isWaAutoReplyEnabled(db, userId);
            if (waAutoReply) {
              await sendWhatsAppMessage(
                PHONE_NUMBER_ID,
                WA_ACCESS_TOKEN,
                msg.from,
                "Maaf, gagal memproses media Anda.",
                msg.messageId,
              );
            }
          } catch {}
        }
      } else {
        const waAutoReply = await isWaAutoReplyEnabled(db, userId);
        await withTypingIndicator(PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.messageId, async () => {
          try {
            // Langkah 5: Rate limit WA Bot channel (per nomor HP — TERPISAH dari Web App counter)
            if (!checkRateLimit(rateLimitWaBot, msg.from, RATE_LIMIT_WA_PER_MINUTE)) {
              if (waAutoReply) {
                await sendWhatsAppMessage(
                  PHONE_NUMBER_ID, WA_ACCESS_TOKEN, msg.from,
                  "Maaf, terlalu banyak permintaan. Tunggu sebentar dan coba lagi.",
                  msg.messageId
                );
              } else {
                await sendPushNotification(
                  SUPABASE_URL,
                  SUPABASE_SERVICE_ROLE_KEY,
                  userId,
                  "Terlalu Banyak Permintaan",
                  "Tunggu sebentar dan coba lagi.",
                  { type: "rate_limited" }
                );
              }
              return;
            }

            const resolvedKeys = await resolveGeminiApiKeys(db, userId);

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

              const handled = await handleV2Message(db, resolvedKeys, msg, userId);

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
                await handleReplyToTransaction(db, resolvedKeys, msg, mapping.transaction_id, userId);
                return;
              }

              const { data: pending } = await db
                .from("wa_pending_transactions")
                .select("id")
                .eq("wa_question_message_id", msg.contextId)
                .single();

              if (pending?.id) {
                await handlePendingNominalReply(db, resolvedKeys, msg, pending.id, userId);
                return;
              }
            }

            // ── Route berdasarkan tipe pesan ────────────────────
            if (msg.type === "text") {
              await handleTextMessage(db, resolvedKeys, msg, userId);
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
              if (waAutoReply) {
                await sendWhatsAppMessage(
                  PHONE_NUMBER_ID,
                  WA_ACCESS_TOKEN,
                  msg.from,
                  "Maaf, ada kesalahan internal. Coba lagi ya.",
                  msg.messageId,
                );
              } else {
                await sendPushNotification(
                  SUPABASE_URL,
                  SUPABASE_SERVICE_ROLE_KEY,
                  userId,
                  "Kesalahan Internal",
                  "Maaf, ada kesalahan saat memproses pesan. Coba lagi ya.",
                  { type: "internal_error" }
                );
              }
            } catch {}
          }
        }, waAutoReply);
      }
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
