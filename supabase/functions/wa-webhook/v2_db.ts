// supabase/functions/wa-webhook/v2_db.ts
// VERSI 2 - Helper database dan state sesi mode terkunci (Revisi Logging)

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ModeSession {
  wa_chat_id: string;
  access_code: string;
  mode: "koreksi" | "limit" | "tujuan" | null;
  session_data: any;
  updated_at: string;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 menit

/**
 * Helper untuk mencatat log ke tabel wa_logs di database (non-blocking)
 */
export async function logToDb(db: SupabaseClient, message: string, details: any = {}) {
  if (message === "getV2Session No Session Found") {
    return;
  }

  const promise = db.from("wa_logs").insert({
    message,
    details: typeof details === "object" ? details : { raw: details },
    created_at: new Date().toISOString()
  });

  try {
    // @ts-ignore
    EdgeRuntime.waitUntil(promise);
  } catch {
    promise.catch((err) => console.error("Gagal logToDb async:", err));
  }
}

/**
 * Mendapatkan sesi mode aktif untuk user.
 * Melakukan auto-cleanup (timeout 5 menit) secara otomatis.
 */
export async function getV2Session(
  db: SupabaseClient,
  waChatId: string,
): Promise<{ session: ModeSession | null; wasTimedOut: boolean }> {
  try {
    const { data, error } = await db
      .from("wa_mode_sessions")
      .select("*")
      .eq("wa_chat_id", waChatId)
      .maybeSingle();

    if (error) {
      await logToDb(db, "getV2Session Error", { waChatId, error });
      return { session: null, wasTimedOut: false };
    }

    if (!data) {
      await logToDb(db, "getV2Session No Session Found", { waChatId });
      return { session: null, wasTimedOut: false };
    }

    const session = data as ModeSession;
    const updatedAt = new Date(session.updated_at).getTime();
    const now = Date.now();

    await logToDb(db, "getV2Session Session Active", { waChatId, session, timeDiff: now - updatedAt });

    if (now - updatedAt > TIMEOUT_MS) {
      // Sesi kedaluwarsa -> hapus
      await clearV2Session(db, waChatId);
      await logToDb(db, "getV2Session Session Timed Out", { waChatId, session });
      return { session: null, wasTimedOut: true };
    }

    return { session, wasTimedOut: false };
  } catch (e) {
    await logToDb(db, "getV2Session Exception", { waChatId, exception: String(e) });
    console.error("Error in getV2Session:", e);
    return { session: null, wasTimedOut: false };
  }
}

/**
 * Menyimpan atau mengupdate sesi mode
 */
export async function saveV2Session(
  db: SupabaseClient,
  waChatId: string,
  accessCode: string,
  mode: "koreksi" | "limit" | "tujuan" | null,
  sessionData: any,
): Promise<boolean> {
  try {
    const { error } = await db.from("wa_mode_sessions").upsert({
      wa_chat_id: waChatId,
      access_code: accessCode,
      mode,
      session_data: sessionData,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      await logToDb(db, "saveV2Session Error", { waChatId, mode, error });
      console.error("Error in saveV2Session:", error);
      return false;
    }
    
    await logToDb(db, "saveV2Session Success", { waChatId, mode, sessionData });
    return true;
  } catch (e) {
    await logToDb(db, "saveV2Session Exception", { waChatId, mode, exception: String(e) });
    console.error("Error in saveV2Session:", e);
    return false;
  }
}

/**
 * Menghapus/keluar dari sesi mode
 */
export async function clearV2Session(
  db: SupabaseClient,
  waChatId: string,
): Promise<boolean> {
  try {
    const { error } = await db
      .from("wa_mode_sessions")
      .delete()
      .eq("wa_chat_id", waChatId);

    if (error) {
      await logToDb(db, "clearV2Session Error", { waChatId, error });
      console.error("Error in clearV2Session:", error);
      return false;
    }
    
    await logToDb(db, "clearV2Session Success", { waChatId });
    return true;
  } catch (e) {
    await logToDb(db, "clearV2Session Exception", { waChatId, exception: String(e) });
    console.error("Error in clearV2Session:", e);
    return false;
  }
}

// ============================================================
// DATA FETCHING HELPERS (Untuk query dan mode)
// ============================================================

export async function v2GetWallets(db: SupabaseClient, accessCode: string) {
  const { data } = await db
    .from("wallets")
    .select("id, name, balance, is_primary, sort_order")
    .eq("access_code", accessCode);
  return data ?? [];
}

export async function v2GetCategories(db: SupabaseClient, accessCode: string) {
  const { data } = await db
    .from("categories")
    .select("id, name, type")
    .eq("access_code", accessCode);
  return data ?? [];
}

export async function v2GetBudgets(
  db: SupabaseClient,
  accessCode: string,
  monthStr: string,
) {
  const { data } = await db
    .from("budgets")
    .select("id, category_id, limit_amount, month")
    .eq("access_code", accessCode)
    .eq("month", monthStr);
  return data ?? [];
}

export async function v2GetSavingsGoals(db: SupabaseClient, accessCode: string) {
  const { data } = await db
    .from("savings_goals")
    .select("id, name, target_amount, wallet_id, target_date")
    .eq("access_code", accessCode);
  return data ?? [];
}

export async function v2GetDebtEntries(db: SupabaseClient, accessCode: string) {
  const { data } = await db
    .from("debt_entries")
    .select("id, person_name, type, amount, date, note, due_date, status, payoff_wallet_id, payoff_date")
    .eq("access_code", accessCode);
  return data ?? [];
}

export async function v2GetRecurringItems(
  db: SupabaseClient,
  accessCode: string,
) {
  const { data } = await db
    .from("recurring_items")
    .select("id, name, type, amount, wallet_id, category_id, day_of_month, active, last_confirmed_date")
    .eq("access_code", accessCode);
  return data ?? [];
}

export async function v2GetTransactions(
  db: SupabaseClient,
  accessCode: string,
  startDate?: string,
  endDate?: string,
) {
  let query = db
    .from("transactions")
    .select("id, wallet_id, category_id, category, type, amount, date, note, to_wallet_id, source")
    .eq("access_code", accessCode);

  if (startDate) {
    query = query.gte("date", startDate);
  }
  if (endDate) {
    query = query.lte("date", endDate);
  }

  const { data } = await query;
  return data ?? [];
}

export async function v2GetUserSettings(db: SupabaseClient, accessCode: string) {
  const { data } = await db
    .from("user_settings")
    .select("nav_config")
    .eq("access_code", accessCode)
    .maybeSingle();
  return data;
}
