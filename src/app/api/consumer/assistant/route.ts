// src/app/api/consumer/assistant/route.ts
// Flow's chat assistant. Two-phase, on purpose:
//   1. parse  — turn free text (any language) into a structured action + a
//      human-readable confirmation reply, in the same language as the input.
//      Nothing moves money here.
//   2. execute — only runs after the person explicitly confirms the exact
//      parsed action. A misheard/mistranslated amount or address with real
//      money behind it is not an acceptable failure mode, so parsing and
//      moving funds are never the same step.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { internalUrl } from '@/src/lib/internalUrl';

const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

interface ParsedAction {
  action: 'send' | 'request' | 'save' | 'balance' | 'unclear';
  amount?: number;
  currency?: string;
  recipientAddress?: string;
  frequencyDays?: number;
  reply: string; // in the same language the person used
}

async function parseWithGroq(message: string): Promise<ParsedAction> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured.');

  const systemPrompt = `You are Flow's payment assistant inside ArcFlare. You read one message from a
person and turn it into a single structured action. You NEVER execute anything
yourself — you only describe what would happen so a human can confirm it.

LANGUAGE RULE (follow exactly, do not skip this): First, identify the language
the person's message is written in. Your "reply" field MUST be written in that
exact same language — never switch to a different one, never default to
Portuguese, French, or anything else unless the person's message was actually
written in that language. If the message is in English, reply in English.

Respond with ONLY a JSON object, no markdown, no commentary, matching exactly:
{
  "action": "send" | "request" | "save" | "balance" | "unclear",
  "amount": number or null,
  "currency": "USDC",
  "recipientAddress": string or null,   // MUST be a literal 0x-prefixed hex address the person gave. Never invent, guess, or auto-complete one. If none is present verbatim, this must be null.
  "frequencyDays": number or null,       // only for "save", e.g. "every week" -> 7
  "reply": string   // in the SAME language as the person's message (see LANGUAGE RULE above)
}

Rules:
- "send $50 to 0xAbc123..." -> action "send", amount 50, recipientAddress the literal address given.
- If there's an amount and a "send"/"pay"/"transfer" verb but no address, action is still "send" but recipientAddress is null, and reply asks for the address.
- If the message is a greeting, small talk, or anything not about money (e.g. "hi", "hello", "what can you do"), action is "unclear" and reply must briefly greet them AND list what you can do, e.g.: "Hi! I can help you send money, request a payment, or save automatically. Try something like 'Send 20 USDC to 0x...' or 'Save 5 USDC every week.'" — translated into their language if they didn't write in English.
- Never mark an action confirmed. Never claim money has moved. You are only ever proposing.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 2048,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Assistant model error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No response from assistant.');

  let parsed: ParsedAction;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not understand the assistant response. Please try again.');
  }

  // Defense in depth — never trust the model's address format blindly.
  if (parsed.recipientAddress && !/^0x[a-fA-F0-9]{40}$/.test(parsed.recipientAddress)) {
    parsed.recipientAddress = undefined;
  }

  return parsed;
}

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const walletAddress = await resolveConsumerSession(req);
    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Please connect your wallet first.' },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { message, confirmedAction } = body;

    // ── Phase 2: execute a previously parsed + confirmed action ──
    if (confirmedAction) {
      const { action, amount, currency, recipientAddress, frequencyDays } = confirmedAction;

      if (action === 'send') {
        if (!recipientAddress || !amount) {
          return NextResponse.json({ success: false, error: 'Missing amount or address.' }, { status: 400 });
        }
        const initRes = await fetch(internalUrl('/api/payments/initialize'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({
            amount,
            currency: currency || 'USDC',
            merchant: recipientAddress,
            payoutAddress: recipientAddress,
            direction: 'send',
          }),
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.error || 'Could not start payment.');

        const settleRes = await fetch(internalUrl('/api/payments/settle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({ reference: initData.reference }),
        });
        const settleData = await settleRes.json();
        if (!settleData.success) throw new Error(settleData.error || 'Could not complete payment.');

        return NextResponse.json({
          success: true,
          reply: `Sent ${amount} ${currency || 'USDC'} to ${recipientAddress}.`,
          txHash: settleData.arcTxHash,
        });
      }

      if (action === 'request') {
        const res = await fetch(internalUrl('/api/payments/initialize'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({ amount, currency: currency || 'USDC', merchant: 'Payment request', direction: 'request' }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Could not create request.');
        return NextResponse.json({
          success: true,
          reply: `Your payment link for ${amount} ${currency || 'USDC'} is ready: ${data.checkoutUrl}`,
        });
      }

      if (action === 'save') {
        const res = await fetch(internalUrl('/api/payments/scheduled'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({
            payerSCA: walletAddress,
            receiverSCA: walletAddress,
            amount,
            intervalDays: frequencyDays || 7,
            description: 'Automatic savings (via assistant)',
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Could not set up savings.');
        return NextResponse.json({
          success: true,
          reply: `Saving ${amount} ${currency || 'USDC'} every ${frequencyDays || 7} day(s).`,
        });
      }

      return NextResponse.json({ success: false, error: 'Unknown confirmed action.' }, { status: 400 });
    }

    // ── Phase 1: parse only, never execute ──
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ success: false, error: 'message is required.' }, { status: 400 });
    }

    const parsed = await parseWithGroq(message);

    const needsConfirmation = parsed.action === 'send' || parsed.action === 'request' || parsed.action === 'save';
    const readyToConfirm = needsConfirmation && (parsed.action !== 'send' || !!parsed.recipientAddress) && !!parsed.amount;

    return NextResponse.json({
      success: true,
      reply: parsed.reply,
      action: readyToConfirm ? parsed : null,
    });
  } catch (error: any) {
    console.error('Assistant error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Assistant failed.' }, { status: 500 });
  }
}