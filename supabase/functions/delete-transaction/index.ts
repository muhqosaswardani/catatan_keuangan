// supabase/functions/delete-transaction/index.ts
// Edge Function untuk menghapus 1 transaksi dan memperbarui saldo dompet secara aman (bypass RLS via service role key).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://qdoduglbejcazjufvfkf.supabase.co";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    const { transaction_id, user_id } = body || {};

    if (!transaction_id) {
      return new Response(JSON.stringify({ error: "transaction_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // 1. Fetch data transaksi
    let query = supabase.from("transactions").select("*").eq("id", transaction_id);
    if (user_id) query = query.eq("user_id", user_id);
    const { data: rows, error: fetchErr } = await query;

    if (fetchErr || !rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: "Transaksi tidak ditemukan atau sudah terhapus" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const tx = rows[0];

    // 2. Delete transaksi
    const { error: delErr } = await supabase.from("transactions").delete().eq("id", transaction_id);
    if (delErr) {
      return new Response(JSON.stringify({ error: delErr.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // 3. Recalculate wallet balance jika transaksi terhubung ke wallet
    if (tx.wallet_id) {
      const uId = tx.user_id || user_id;
      let txQuery = supabase.from("transactions").select("type, amount, wallet_id, to_wallet_id");
      if (uId) {
        txQuery = txQuery.eq("user_id", uId).or(`wallet_id.eq.${tx.wallet_id},to_wallet_id.eq.${tx.wallet_id}`);
      } else {
        txQuery = txQuery.or(`wallet_id.eq.${tx.wallet_id},to_wallet_id.eq.${tx.wallet_id}`);
      }
      const { data: remainingTxs } = await txQuery;

      let balance = 0;
      if (Array.isArray(remainingTxs)) {
        for (const r of remainingTxs) {
          if (r.type === "transfer") {
            if (r.wallet_id === tx.wallet_id) balance -= Number(r.amount) || 0;
            if (r.to_wallet_id === tx.wallet_id) balance += Number(r.amount) || 0;
          } else if (r.wallet_id === tx.wallet_id) {
            balance += r.type === "income" ? (Number(r.amount) || 0) : -(Number(r.amount) || 0);
          }
        }
      }

      await supabase
        .from("wallets")
        .update({ balance, updated_at: new Date().toISOString() })
        .eq("id", tx.wallet_id);
    }

    return new Response(
      JSON.stringify({ success: true, note: tx.note || "Transaksi" }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[delete-transaction] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
