export interface ChatContextMessage {
  text: string;
  messageId: string;
}

export interface ChatContextStore {
  isWebChat: boolean;
  messages: ChatContextMessage[];
}

// Simple global context (safe: each Edge Function invocation is isolated)
let _chatStore: ChatContextStore | null = null;

export const chatContext = {
  run<T>(store: ChatContextStore, fn: () => Promise<T>): Promise<T> {
    _chatStore = store;
    return fn().finally(() => { _chatStore = null; });
  },
  getStore(): ChatContextStore | null {
    return _chatStore;
  }
};

const WA_API_BASE = "https://graph.facebook.com/v20.0";

export async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  replyToMessageId?: string,
): Promise<string> {
  const store = chatContext.getStore();
  if (store && store.isWebChat) {
    const msgId = "msg_web_" + Math.random().toString(36).slice(2, 9);
    store.messages.push({ text: body, messageId: msgId });
    return msgId;
  }

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: false },
  };

  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }

  const res = await fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`WA send failed ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  // Kembalikan message_id dari bubble yang dikirim (untuk mapping)
  return data?.messages?.[0]?.id ?? "";
}

export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  // Langkah 1: Dapatkan URL download dari media ID
  const metaRes = await fetch(`${WA_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaRes.ok) {
    throw new Error(`WA media meta failed ${metaRes.status}`);
  }

  const meta = await metaRes.json();
  const mediaUrl: string = meta.url;
  const mimeType: string = meta.mime_type ?? "application/octet-stream";

  // Langkah 2: Download file dari URL
  const dlRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!dlRes.ok) {
    throw new Error(`WA media download failed ${dlRes.status}`);
  }

  const buffer = await dlRes.arrayBuffer();
  return { data: new Uint8Array(buffer), mimeType };
}

export function markAsRead(
  phoneNumberId: string,
  accessToken: string,
  messageId: string,
): Promise<void> {
  return fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).then(() => undefined);
}

export function sendTypingIndicator(
  phoneNumberId: string,
  accessToken: string,
  messageId: string,
): Promise<void> {
  return fetch(`${WA_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: {
        type: "text",
      },
    }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`Typing indicator failed: ${res.status} - ${errText.slice(0, 150)}`);
      }
    })
    .catch((err) => {
      console.warn("Typing indicator request failed:", err);
    });
}

export async function withTypingIndicator<T>(
  phoneNumberId: string,
  accessToken: string,
  messageId: string,
  fn: () => Promise<T>,
): Promise<T> {
  let active = true;
  // Send immediate typing indicator
  sendTypingIndicator(phoneNumberId, accessToken, messageId).catch(() => {});

  const intervalId = setInterval(() => {
    if (!active) {
      clearInterval(intervalId);
      return;
    }
    sendTypingIndicator(phoneNumberId, accessToken, messageId).catch(() => {});
  }, 12000);

  try {
    return await fn();
  } finally {
    active = false;
    clearInterval(intervalId);
  }
}

export function safeBytesToBase64(bytes: Uint8Array): string {
  let binString = "";
  const chunkSize = 16384; // 16KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binString += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binString);
}

export async function sendPushNotification(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ user_id: userId, title, body, data: data ?? {} })
    });
    if (!res.ok) {
      console.error("[sendPushNotification] HTTP Error:", res.status, await res.text());
      return false;
    }
    const json = await res.json();
    console.log("[sendPushNotification] Result:", json);
    return true;
  } catch (err) {
    console.error("[sendPushNotification] Exception:", err);
    return false;
  }
}

export async function sendUserResponse(
  db: any,
  phoneNumberId: string,
  accessToken: string,
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  waChatId: string,
  textReply: string,
  replyToMessageId?: string,
  pushPayload?: { title: string; body: string; data?: Record<string, unknown> }
): Promise<string> {
  let waAutoReply = true;
  const { data: st } = await db.from("user_settings").select("wa_auto_reply").eq("user_id", userId).maybeSingle();
  if (st && typeof st.wa_auto_reply === "boolean") {
    waAutoReply = st.wa_auto_reply;
  }

  let aiLocked = false;
  const { data: usr } = await db.from("users").select("ai_locked").eq("id", userId).maybeSingle();
  if (usr && typeof usr.ai_locked === "boolean") {
    aiLocked = usr.ai_locked;
  }

  if (aiLocked) {
    const lockedMsg = "Fitur AI saat ini terkunci (periode uji coba habis). Silakan hubungi admin atau masukkan token aktivasi di aplikasi web untuk membuka akses.";
    if (waAutoReply) {
      return await sendWhatsAppMessage(phoneNumberId, accessToken, waChatId, lockedMsg, replyToMessageId);
    } else {
      await sendPushNotification(supabaseUrl, serviceRoleKey, userId, "Fitur AI Terkunci", lockedMsg, { type: "ai_locked" });
      return "";
    }
  }

  let sentMsgId = "";
  if (waAutoReply) {
    if (textReply) {
      sentMsgId = await sendWhatsAppMessage(phoneNumberId, accessToken, waChatId, textReply, replyToMessageId);
    }
    if (pushPayload) {
      await sendPushNotification(supabaseUrl, serviceRoleKey, userId, pushPayload.title, pushPayload.body, pushPayload.data);
    }
  } else {
    if (pushPayload) {
      await sendPushNotification(supabaseUrl, serviceRoleKey, userId, pushPayload.title, pushPayload.body, pushPayload.data);
    } else if (textReply) {
      await sendPushNotification(supabaseUrl, serviceRoleKey, userId, "Jawaban Asisten KaslyAI", textReply, { type: "query_response" });
    }
  }

  return sentMsgId;
}
