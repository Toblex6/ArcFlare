// src/app/api/merchant/payroll-assistant/route.ts
// LLM-backed payroll chat assistant. Replaces the regex parser in
// src/lib/payrollChatParser.ts as the PRIMARY path (the parser is kept as
// the client-side fallback on LLM outage/failure).
//
// Provider/config: Groq — the SAME provider, endpoint and env vars
// (GROQ_API_KEY / GROQ_MODEL) the agent brain (api/agent/brain/route.ts)
// and merchant assistant (api/merchant/assistant/route.ts) already use.
// No new LLM provider is introduced.
//
// SECURITY (non-negotiable, same model as the agent brain):
//  - The LLM's tool-calls NEVER supply a payer/vault wallet address or
//    wallet ID. run_payroll's intent carries NO wallet fields; the client
//    executes it with the caller's own credential (merchant cookie ->
//    /api/payroll/run, whose server-side wallet resolution is untouched;
//    consumer cookie -> Flow's initialize+settle send path, which debits
//    the session wallet only). This route does not execute payroll at all.
//  - The vault address used for balance lookups comes from the page state
//    or, for consumers, defaults to their session wallet — never from the
//    LLM.
//  - A contractor's payout address comes from the user's own chat text
//    ("add flare 0xAbc… as a contractor") — that's the existing behavior
//    and is validated server-side here before being surfaced as an intent.
//  - check_balance is executed server-side via getUsdcBalance() — the SAME
//    helper the Telegram /balance command uses (botHandlers.handleBalance).

import { NextRequest, NextResponse } from 'next/server';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { resolveConsumerSession } from '@/lib/middleware/withConsumerAuth';
import { getUsdcBalance } from '@/lib/wallet/usdcBalance';

// The payroll chat is reachable from BOTH sides of the product:
//   - merchants (dashboard cookie or x-api-key) — full payroll
//   - consumers (Flow session cookie) — their own wallet as the "vault"
// resolveCaller never falls through silently: a caller that presented no
// valid credential gets null and the route 401s.
async function resolveCaller(req: NextRequest): Promise<
  | { type: 'merchant'; walletAddress?: string }
  | { type: 'consumer'; walletAddress: string }
  | null
> {
  const merchant = await resolveMerchant(req);
  if (merchant) {
    // API-key calls don't carry the merchant's wallet address; the page
    // supplies the vault it typed. Cookie callers get their wallet below
    // via the page's /api/merchant/me lookup — this branch only answers
    // "is this a legitimate merchant".
    return { type: 'merchant' };
  }
  const consumerWallet = await resolveConsumerSession(req);
  if (consumerWallet) {
    return { type: 'consumer', walletAddress: consumerWallet };
  }
  return null;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const SCA_RE = /^0x[a-fA-F0-9]{40}$/;
const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

// ── Tool schemas (OpenAI/Groq function format, mirroring the brain route) ──
// NOTE: no tool accepts a payer/vault wallet address or wallet ID. The only
// address the LLM can name is a CONTRACTOR's payout address, which the user
// typed into chat themselves.
const PAYROLL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'add_contractor',
      description: "Add a contractor to the payroll list. Use when the user names a person and a wallet address, e.g. 'add flare 0xAbc… as a contractor at 2 USDC monthly'.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Contractor's name" },
          address: { type: 'string', description: "Contractor's payout wallet address (0x…)" },
          amount: { type: 'number', description: 'USDC amount per payment' },
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          intervalDays: { type: 'number', description: 'Exact interval in days for custom cadences like "every 4 weeks" (would be 28)' },
        },
        required: ['name', 'address', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_contractor',
      description: "Remove ONE contractor by name from the payroll list. Use for 'remove Manny'. For clearing everyone use clear_contractors.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name of the contractor to remove' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_contractors',
      description: "List the contractors currently on the payroll. Use for 'list my contractors' or 'who do I pay'.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_contractors',
      description: "Remove ALL contractors from the payroll list. Use for 'clear all contractors'.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_balance',
      description: "Check the real USDC balance of the user's payroll vault wallet. Use for 'what's my balance'. Takes no arguments — the vault is resolved server-side.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_schedule',
      description: "Set how often payroll runs. Use for 'set payroll to run weekly' or 'run payroll every 14 days'.",
      parameters: {
        type: 'object',
        properties: {
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          intervalDays: { type: 'number', description: 'Exact interval in days for custom cadences' },
        },
        required: ['frequency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_payroll',
      description: "Pay everyone on the payroll list NOW. Use for 'run payroll'. Takes no arguments — the paying wallet is resolved from the user's session, never from this conversation.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_receipts',
      description: "Show receipts from the last payroll run. Use for 'show my receipts'.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const SYSTEM_PROMPT = `You are FlareHQ's payroll assistant, a friendly chat interface for managing contractor payroll.

Rules:
- Map the user's message to the closest tool. If they're just chatting (greetings like "hi", "what can you do", thanks, small talk), do NOT call a tool — reply conversationally and briefly mention what you can do: add/remove/list/clear contractors, check the vault balance, set the payroll schedule, run payroll, and show receipts.
- When adding a contractor, extract name, wallet address (0x…), amount, and cadence from the user's OWN words. If a required piece is missing, ask for it instead of calling the tool.
- Never invent, guess, or alter wallet addresses, amounts, or the paying wallet. The paying wallet is configured by the user outside this chat and is out of your control entirely.
- When you call a tool, its result comes back to you — summarize the outcome in one or two short sentences.`;

interface ContractorInput {
  name?: string;
  address?: string;
  amount?: number;
  frequency?: string;
  intervalDays?: number;
}

function sanitizeAddArgs(args: ContractorInput): { ok: true; intent: any } | { ok: false; error: string } {
  const name = (args.name || '').trim().slice(0, 60);
  const address = (args.address || '').trim();
  const amount = Number(args.amount);
  if (!name) return { ok: false, error: 'Contractor name is required.' };
  if (!SCA_RE.test(address)) return { ok: false, error: 'A valid 0x… wallet address is required.' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number.' };
  const frequency = FREQUENCIES.includes((args.frequency || 'monthly') as any) ? (args.frequency || 'monthly') : 'monthly';
  const intervalDays = Number.isFinite(Number(args.intervalDays)) && Number(args.intervalDays) > 0 ? Number(args.intervalDays) : undefined;
  return { ok: true, intent: { type: 'add_contractor', name, address, amount, frequency, intervalDays } };
}

// GET — real vault balance for the chat UI (both the LLM path and the regex
// fallback path render it). Same lookup as Telegram /balance. Consumers may
// omit ?vaultAddress — their session wallet IS the vault.
export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
  }
  const vaultAddress = req.nextUrl.searchParams.get('vaultAddress') || (caller.type === 'consumer' ? caller.walletAddress : '');
  if (!SCA_RE.test(vaultAddress)) {
    return NextResponse.json({ success: false, error: 'vaultAddress query param (0x…) is required.' }, { status: 400 });
  }
  try {
    const balance = await getUsdcBalance(vaultAddress);
    return NextResponse.json({ success: true, balance, address: vaultAddress });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not fetch balance right now.' }, { status: 502 });
  }
}

// Executes a whitelisted tool call. Mutating tools return a VALIDATED intent
// for the client to apply — nothing here executes payroll or moves funds.
// Any tool-argument keys that look like payer/vault wallet identifiers are
// ignored by construction (the tool schemas don't accept them, and the
// executor never reads wallet fields from args).
async function executeTool(
  name: string,
  args: any,
  ctx: { vaultAddress: string }
): Promise<{ result: any; intent?: any }> {
  switch (name) {
    case 'add_contractor': {
      const sanitized = sanitizeAddArgs(args || {});
      if (!sanitized.ok) return { result: { error: sanitized.error } };
      return {
        result: { added: sanitized.intent.name, amount: sanitized.intent.amount, frequency: sanitized.intent.frequency },
        intent: sanitized.intent,
      };
    }
    case 'remove_contractor': {
      const name = (args?.name || '').trim().slice(0, 60);
      if (!name) return { result: { error: 'Contractor name is required.' } };
      return { result: { removed: name }, intent: { type: 'remove_contractor', name } };
    }
    case 'list_contractors':
      // The client renders its own contractor list; the intent tells it to.
      return { result: { ok: true }, intent: { type: 'list_contractors' } };
    case 'clear_contractors':
      return { result: { ok: true }, intent: { type: 'clear_contractors' } };
    case 'check_balance': {
      // Real balance via the Telegram-/balance lookup. vaultAddress comes
      // from the page's session state — never from LLM args.
      if (!SCA_RE.test(ctx.vaultAddress)) {
        return { result: { error: 'No vault wallet set yet — add it in the field above the chat first.' } };
      }
      try {
        const balance = await getUsdcBalance(ctx.vaultAddress);
        return { result: { balance, currency: 'USDC', address: ctx.vaultAddress } };
      } catch {
        return { result: { error: 'Balance lookup failed — try again shortly.' } };
      }
    }
    case 'set_schedule': {
      const frequency = FREQUENCIES.includes(args?.frequency) ? args.frequency : null;
      if (!frequency) return { result: { error: 'frequency must be daily, weekly, or monthly.' } };
      const intervalDays = Number.isFinite(Number(args?.intervalDays)) && Number(args.intervalDays) > 0 ? Number(args.intervalDays) : undefined;
      return { result: { frequency, intervalDays }, intent: { type: 'set_schedule', frequency, intervalDays } };
    }
    case 'run_payroll':
      // Deliberately argument-free: the client executes against
      // /api/payroll/run with wallet fields from ITS OWN state.
      return { result: { ok: true }, intent: { type: 'run_payroll' } };
    case 'show_receipts':
      return { result: { ok: true }, intent: { type: 'show_receipts' } };
    default:
      return { result: { error: `Unknown tool ${name}.` } };
  }
}

// POST — the LLM chat loop.
// Body: { message, contractors, schedule, vaultAddress, history? }
// Response: { success, reply?, intent?, toolsUsed?, source: 'llm' }
// On Groq outage/misconfiguration this returns 5xx and the client falls back
// to the regex parser instead of showing an error.
export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
  }
  if (!GROQ_API_KEY) {
    return NextResponse.json({ success: false, error: 'LLM is not configured.' }, { status: 502 });
  }

  const body = await req.json().catch(() => ({}));
  const message: string = (body.message || '').toString().slice(0, 2000);
  if (!message.trim()) {
    return NextResponse.json({ success: false, error: 'message is required.' }, { status: 400 });
  }
  const contractors: any[] = Array.isArray(body.contractors) ? body.contractors : [];
  const schedule: string | null = body.schedule || null;
  // The vault the caller is paying from. A consumer's session wallet is the
  // trusted default; a merchant must name their own vault (the page sends
  // the wallet address from their /api/merchant/me profile).
  const vaultAddress: string =
    (body.vaultAddress || '').toString() || (caller.type === 'consumer' ? caller.walletAddress : '');

  const contextNote =
    `Current payroll state:\n` +
    `- Contractors (${contractors.length}): ${contractors.map((c) => `${c.name} at ${c.amount} USDC ${c.frequency || ''}`).join('; ') || 'none'}\n` +
    `- Schedule: ${schedule || 'not set'}\n`;

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n' + contextNote },
    { role: 'user', content: message },
  ];

  let toolsUsed: string[] = [];
  let pendingIntent: any = null;

  try {
    for (let iter = 0; iter < 4; iter++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 1024,
          temperature: 0.2,
          messages,
          tools: PAYROLL_TOOLS,
          tool_choice: 'auto',
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`[payroll-assistant] Groq error ${res.status}:`, detail.slice(0, 300));
        return NextResponse.json({ success: false, error: 'LLM backend error.' }, { status: 502 });
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) {
        return NextResponse.json({ success: false, error: 'LLM returned no usable response.' }, { status: 502 });
      }
      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        const reply = msg.content || (pendingIntent ? 'Done.' : "I didn't get a usable response — please try again.");
        return NextResponse.json({ success: true, reply, intent: pendingIntent, toolsUsed, source: 'llm' });
      }

      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
        toolsUsed.push(name);
        const { result, intent } = await executeTool(name, args, { vaultAddress });
        if (intent) pendingIntent = intent;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
    return NextResponse.json({ success: true, reply: "I've completed that.", intent: pendingIntent, toolsUsed, source: 'llm' });
  } catch (error: any) {
    console.error('[payroll-assistant] Error:', error?.message);
    return NextResponse.json({ success: false, error: 'LLM backend error.' }, { status: 502 });
  }
}




