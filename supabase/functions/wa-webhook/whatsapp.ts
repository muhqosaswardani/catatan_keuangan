// supabase/functions/wa-webhook/whatsapp.ts
// Modul: WhatsApp Cloud API — kirim pesan, download media

const WA_API_BASE = "https://graph.facebook.com/v20.0";

export async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  replyToMessageId?: string,
): Promise<string> {
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
