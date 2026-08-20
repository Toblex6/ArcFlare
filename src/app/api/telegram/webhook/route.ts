/**
 * src/app/api/telegram/webhook/route.ts
 *
 * Production webhook receiver for the Telegram bot. Telegram POSTs
 * updates here after setWebhook is configured (see README for the
 * one-time registration call).
 *
 * SECURITY — required, not optional, since this is production:
 * Telegram supports a secret token header (X-Telegram-Bot-Api-Secret-Token)
 * set at webhook-registration time, which Telegram echoes back on every
 * request. This route REJECTS any request missing or mismatching that
 * token — without this check, anyone who discovers this URL could POST
 * fake "updates" and trigger bot commands (including wallet-touching ones
 * like /withdraw) as if they came from Telegram. This is not optional
 * hardening, it's the only thing standing between this endpoint and being
 * a fully open command injection surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  handleStart,
  handleApply,
  handleListJobs,
  handleDeliver,
  handleBalance,
  handleWithdraw,
  handleConfirmWithdraw,
  handleCancelWithdraw,
  handleHelp,
  handleGasRetry,
  type BotReply,
} from '@/lib/telegram/botHandlers';
import { trackUpdate } from '@/lib/telegram/webhookDedupe';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

if (!TELEGRAM_WEBHOOK_SECRET) {
  console.error(
    '[telegram/webhook] TELEGRAM_WEBHOOK_SECRET is not set — all incoming webhook requests will be rejected. ' +
    'Set this before registering the webhook with Telegram (see README for the setWebhook call).'
  );
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    from: { id: number; first_name?: string; username?: string };
    chat: { id: number };
    text?: string;
  };
}

async function sendMessage(chatId: number, reply: BotReply): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[telegram/webhook] TELEGRAM_BOT_TOKEN is not set — cannot send reply');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: reply.text,
      parse_mode: reply.parseMode,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram/webhook] sendMessage failed (${res.status}): ${body}`);
  }
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  return { command, args };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
  if (!TELEGRAM_WEBHOOK_SECRET || secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const message = update.message;
  if (!message?.text || !message.from || !message.chat) {
    return NextResponse.json({ ok: true });
  }

  // Duplicate delivery of the same update (Telegram redelivers with the
  // same update_id until it gets a 200) — respond ok without re-running the
  // command (the handlers are idempotent anyway; this avoids the redundant
  // round-trip and any re-entrancy on wallet-touching commands).
  if (update.update_id !== undefined && trackUpdate(update.update_id)) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = String(message.from.id);
  const chatId = message.chat.id;
  const displayName = message.from.first_name || message.from.username || 'there';

  const parsed = parseCommand(message.text);
  if (!parsed) {
    await sendMessage(chatId, { text: `Not sure what you mean. Type /help to see available commands.` });
    return NextResponse.json({ ok: true });
  }

  let reply: BotReply;
  try {
    switch (parsed.command) {
      case '/start':
        reply = await handleStart(telegramUserId, displayName);
        break;
      case '/help':
        reply = await handleHelp();
        break;
      case '/jobs':
        reply = await handleListJobs();
        break;
      case '/apply': {
        const [jobId, ...pitchParts] = parsed.args;
        if (!jobId || pitchParts.length === 0) {
          reply = { text: `Usage: /apply <jobId> <your pitch>` };
        } else {
          reply = await handleApply(telegramUserId, jobId, pitchParts.join(' '));
        }
        break;
      }
      case '/deliver': {
        const [jobId, ...submissionParts] = parsed.args;
        if (!jobId || submissionParts.length === 0) {
          reply = { text: `Usage: /deliver <jobId> <link or description>` };
        } else {
          reply = await handleDeliver(telegramUserId, jobId, submissionParts.join(' '));
        }
        break;
      }
      case '/balance':
        reply = await handleBalance(telegramUserId);
        break;
      case '/withdraw': {
        const [destination, amount] = parsed.args;
        if (!destination) {
          reply = { text: `Usage: /withdraw <your wallet address> [amount]` };
        } else {
          reply = await handleWithdraw(telegramUserId, destination, amount);
        }
        break;
      }
      case '/confirm':
        reply = await handleConfirmWithdraw(telegramUserId);
        break;
      case '/cancel':
        reply = await handleCancelWithdraw(telegramUserId);
        break;
      case '/retrygas':
        reply = await handleGasRetry(telegramUserId);
        break;
      default:
        reply = { text: `Unknown command. Type /help to see what's available.` };
    }
  } catch (err) {
    console.error(`[telegram/webhook] handler error for command ${parsed.command}:`, err);
    reply = { text: `Something went wrong processing that. Please try again.` };
  }

  await sendMessage(chatId, reply);
  return NextResponse.json({ ok: true });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'method not allowed' }, { status: 405 });
}
