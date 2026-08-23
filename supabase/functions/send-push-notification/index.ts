// supabase/functions/send-push-notification/index.ts
// Fase 2 Bagian 1: Fungsi internal untuk kirim Web Push notification
// ke semua device (push subscription) milik satu user.
//
// DESAIN: fungsi ini dipanggil oleh Edge Function LAIN (mis. wa-webhook di
// Bagian 3, atau handler Transaksi AI Cepat di Bagian 2), BUKAN dipanggil
// langsung dari browser untuk kirim notifikasi sembarang user. Endpoint ini
// tetap butuh Authorization header (service_role atau anon+JWT user sendiri)
// karena Supabase Edge Functions selalu verify JWT secara default — untuk
// panggilan antar-function pakai service_role key.
//
// Body request (JSON):
//   { "user_id": "<uuid>", "title": "...", "body": "...", "data": {...} }
// "data" bebas isinya, dipakai oleh service worker (notificationclick) untuk
// tahu mau buka/route ke mana & aksi apa (Edit/Hapus/Lengkapi) — detail
// logic-nya baru diisi penuh di Bagian 2 & 3.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@kaslyai.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface SendPushBody {
  user_id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  // CORS: fungsi ini dipanggil langsung dari browser (tombol "Kirim Notifikasi
  // Uji Coba" di Pengaturan), jadi wajib jawab preflight OPTIONS + kasih header CORS.
  const requestOrigin = req.headers.get("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  let payload: SendPushBody;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const { user_id, title, body, data } = payload;
  if (!user_id || !title || !body) {
    return new Response(
      JSON.stringify({ error: "user_id, title, dan body wajib diisi" }),
      { status: 400, headers: corsHeaders },
    );
  }

  const { data: subs, error: fetchErr } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", user_id);

  if (fetchErr) {
    console.error("[send-push-notification] gagal ambil subscriptions:", fetchErr);
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  if (!subs || subs.length === 0) {
    return new Response(
      JSON.stringify({ sent: 0, failed: 0, message: "User tidak punya push subscription aktif" }),
      { status: 200, headers: corsHeaders },
    );
  }

  const notificationPayload = JSON.stringify({ title, body, data: data ?? {} });

  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        notificationPayload,
      ).then(() => sub).catch((err) => {
        throw { sub, err };
      }),
    ),
  );

  let sent = 0;
  const staleIds: string[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      sent++;
    } else {
      const { sub, err } = r.reason as { sub: { id: string }; err: any };
      const statusCode = err?.statusCode;
      // 404/410 = subscription sudah tidak valid (device uninstall, dsb) -> bersihkan
      if (statusCode === 404 || statusCode === 410) {
        staleIds.push(sub.id);
      } else {
        console.error("[send-push-notification] gagal kirim ke satu device:", err?.message ?? err);
      }
    }
  }

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase.from("push_subscriptions").delete().in("id", staleIds);
    if (delErr) console.error("[send-push-notification] gagal hapus subscription basi:", delErr);
  }

  return new Response(
    JSON.stringify({ sent, failed: subs.length - sent, cleaned: staleIds.length }),
    { status: 200, headers: corsHeaders },
  );
});
