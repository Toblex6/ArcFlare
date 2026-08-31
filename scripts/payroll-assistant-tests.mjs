/**
 * scripts/payroll-assistant-tests.mjs
 *
 * Tests for the LLM-backed payroll assistant + real balance check.
 * Static proofs run always; live checks run only when a dev server with
 * GROQ_API_KEY is reachable at TEST_BASE_URL (default http://localhost:3000).
 *
 * Asserts:
 *  1. STATIC: the regex parser is kept as the fallback (page still imports it).
 *  2. STATIC: no LLM tool schema accepts a payer/vault wallet address or
 *     wallet ID — payroll execution wallets can never be redirected by the
 *     LLM (run_payroll's intent is argument-free and the client executes
 *     against /api/payroll/run with its own session-state wallet fields).
 *  3. STATIC: check_balance is wired to getUsdcBalance (the Telegram
 *     /balance lookup), not the old stub string.
 *  4. LIVE: unauthenticated POST → 401; "hi" gets a conversational reply;
 *     check_balance returns a real number; LLM failure → 502 (fallback).
 *
 * Run: node scripts/payroll-assistant-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('═══ Payroll assistant — static proofs ═══');

const page = readFileSync(join(here, '..', 'src', 'app', 'payroll-chat', 'page.tsx'), 'utf8');
ok(page.includes('parsePayrollCommand'), 'page keeps the regex parser as the LLM-outage fallback');
ok(page.includes('/api/merchant/payroll-assistant'), 'page calls the LLM assistant route as the primary path');
ok(page.includes('AbortSignal.timeout(20000)'), 'LLM path times out (20s) so fallback engages on hangs');
ok(!page.includes("isn't live yet"), 'balance stub string removed from the page');
ok(page.includes('payroll-assistant?vaultAddress='), 'page check_balance fetches a real balance');

const route = readFileSync(join(here, '..', 'src', 'app', 'api', 'merchant', 'payroll-assistant', 'route.ts'), 'utf8');
const toolBlock = route.slice(route.indexOf('const PAYROLL_TOOLS'), route.indexOf('const SYSTEM_PROMPT'));
for (const intent of ['add_contractor', 'list_contractors', 'clear_contractors', 'check_balance', 'set_schedule', 'run_payroll', 'show_receipts']) {
  ok(toolBlock.includes(`'${intent}'`), `tool set includes ${intent}`);
}
ok(toolBlock.includes("'remove_contractor'"), 'tool set adds remove_contractor ("remove Manny")');
// The payer/vault wallet must never be an LLM-controllable field.
ok(!/payerWalletId|payerSCA|vaultWalletId/.test(toolBlock), 'no tool schema exposes payer/vault wallet IDs');
ok(route.includes('resolveMerchant(req)'), 'route requires authentication via resolveMerchant (same as /api/payroll/run)');
ok(/run_payroll'[\s\S]*?type: 'run_payroll' \}/.test(route), 'run_payroll intent is argument-free (wallet fields come from client session only)');
ok(route.includes('getUsdcBalance'), 'check_balance uses the real getUsdcBalance lookup (Telegram /balance pattern)');
ok(route.includes('api.groq.com') && route.includes('GROQ_MODEL'), 'LLM provider is Groq — same config as the agent brain');

const parser = readFileSync(join(here, '..', 'src', 'lib', 'payrollChatParser.ts'), 'utf8');
for (const intent of ['add_contractor', 'list_contractors', 'clear_contractors', 'check_balance', 'set_schedule', 'run_payroll', 'show_receipts']) {
  ok(parser.includes(`"${intent}"`), `parser still supports ${intent}`);
}

console.log('\n═══ Payroll assistant — live API (server at ' + BASE + ') ═══');
let serverUp = false;
try {
  const res = await fetch(`${BASE}/api/merchant/payroll-assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
  serverUp = res.status > 0;
} catch { /* not running */ }

if (!serverUp) {
  console.log('  (dev server unreachable — live checks skipped; start `npm run dev` or set TEST_BASE_URL)');
} else {
  const unauth = await fetch(`${BASE}/api/merchant/payroll-assistant`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
  });
  ok(unauth.status === 401, 'unauthenticated chat is rejected 401', `got ${unauth.status}`);

  const key = process.env.ARCFLARE_API_KEY || process.env.NEXT_PUBLIC_ARCFLARE_API_KEY;
  if (key) {
    const authed = await fetch(`${BASE}/api/merchant/payroll-assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ message: 'hi', contractors: [], schedule: null, vaultAddress: '' }),
    });
    if (authed.status === 200) {
      const data = await authed.json();
      ok(data.success && typeof data.reply === 'string' && data.reply.length > 0, 'a plain "hi" gets a conversational LLM reply', JSON.stringify(data).slice(0, 120));
      ok(!data.reply.includes("didn't quite catch that"), 'reply is not the canned regex fallback');
      const vault = process.env.TEST_VAULT_ADDRESS || '';
      if (vault) {
        const balRes = await fetch(`${BASE}/api/merchant/payroll-assistant?vaultAddress=${vault}`, { headers: { 'x-api-key': key } });
        const bal = await balRes.json();
        ok(bal.success && typeof bal.balance === 'number', 'check_balance returns a real number, not the stub string', JSON.stringify(bal).slice(0, 120));
      }
      const addRes = await fetch(`${BASE}/api/merchant/payroll-assistant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ message: 'add flare 0xAbC0000000000000000000000000000000000001 as a contractor at 2 USDC monthly', contractors: [], schedule: null, vaultAddress: '' }),
      });
      if (addRes.status === 200) {
        const addData = await addRes.json();
        ok(addData.intent?.type === 'add_contractor' && /^0x[a-fA-F0-9]{40}$/.test(addData.intent.address || ''),
          'LLM extracts a validated add_contractor intent from natural language', JSON.stringify(addData.intent));
        ok(!(addData.intent && ('payerWalletId' in addData.intent || 'payerSCA' in addData.intent)),
          'extracted intent carries no payer wallet fields');
      } else {
        ok(false, 'LLM add_contractor extraction', `HTTP ${addRes.status}`);
      }
    } else {
      ok(authed.status === 502, 'LLM misconfigured → 502 so the client falls back to the parser', `got ${authed.status}`);
    }
  } else {
    console.log('  (no API key in env — authenticated live checks skipped)');
  }
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
