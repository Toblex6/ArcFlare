/**
 * sendTelegramMessage.ts
 *
 * Minimal helper to send a direct message to a Telegram user via Bot API.
 * Used for best-effort side effects (e.g. job completion notification).
 * Never throws on Telegram API failure — caller decides whether to log.
 */

export async function sendTelegramMessage(telegramUserId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    console.error("[telegram/send] TELEGRAM_BOT_TOKEN not set — cannot send to", telegramUserId);
    return;
  }
  // telegramUserId is the `from.id` string; for 1:1 private chats chat_id == user_id
  const chatId = telegramUserId;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[telegram/send] sendMessage to ${telegramUserId} failed (${res.status}): ${body}`);
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
