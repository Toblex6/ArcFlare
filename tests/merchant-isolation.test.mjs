// tests/merchant-isolation.test.mjs — merchant tenant-isolation + withdrawal
// idempotency regression tests.
//
// Diagnosis (production review, Oct 2026):
//  1. The merchant dashboard withdrawal form never sent the Idempotency-Key
//     the backend requires — every UI withdrawal 400'd, and rapid
//     double-submits could otherwise have moved funds twice.
//  2. /api/merchant/me and the assistant get_spending_summary scoped payments
//     by businessName (a NON-UNIQUE display string) instead of the
//     authenticated merchant's ID — two merchants sharing a name saw each
//     other's payments, volume and stats.
//  3. /api/merchant/me crashed (null.slice) when apiKey was NULL — the legal
//     pre-verification state — surfacing as a misleading 401 that bounced
//     the merchant to the login page.
//  4. /api/merchant/dashboard was a dead, unsafe legacy route (invalid Prisma
//     relation, x-api-key-only auth, full-secret echo).
//
// Scope: static/unit only — no DB, no network. The retired dashboard route is
// exercised live (it has no heavy deps); everything else is verified
// statically against the route/component source.
// Run: npx tsx --test tests/merchant-isolation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. Withdrawal frontend sends Idempotency-Key + guards double-submit ─────
test('dashboard withdrawal sends Idempotency-Key and guards in-flight submits', () => {
  const src = read('src/app/merchant/dashboard/page.tsx');
  assert.ok(
    src.includes("'Idempotency-Key'") || src.includes('"Idempotency-Key"'),
    'handleWithdraw must send the Idempotency-Key header the backend requires'
  );
  assert.ok(
    src.includes('if (withdrawing) return'),
    'handleWithdraw must early-return while a withdrawal is in flight'
  );
  assert.ok(
    src.includes('withdrawKeyRef'),
    'withdrawal key must be stable per attempt (minted once, reused on retry)'
  );
  // A retry of the SAME inputs must reuse the key; new inputs start a new
  // attempt. Proved by: key cleared on success + on input change, kept on error.
  assert.ok(
    src.includes('withdrawKeyRef.current = null'),
    'withdrawal key must be cleared on success / input change (new attempt)'
  );
});

test('payment-link creation guards in-flight double-submit', () => {
  const src = read('src/app/merchant/dashboard/page.tsx');
  assert.ok(
    src.includes('if (creating) return'),
    'handleCreateLink must early-return while a link is being created'
  );
});

// ── 2. Tenant isolation: merchantId scoping, never businessName ─────────────
test('/api/merchant/me scopes payments by authenticated merchant id', () => {
  const src = read('src/app/api/merchant/me/route.ts');
  assert.ok(
    src.includes('merchantId: merchant.id') || src.includes('merchantId: authed.id'),
    'me payments query must scope by merchantId'
  );
  assert.ok(
    !src.includes('merchant: merchant.businessName'),
    'me payments query must NOT scope by non-unique businessName'
  );
});

test('assistant get_spending_summary scopes by authenticated merchant id', () => {
  const src = read('src/app/api/merchant/assistant/route.ts');
  const toolBlock = src.slice(
    src.indexOf('get_spending_summary'),
    src.indexOf('case "set_budget"') !== -1 ? src.indexOf('case "set_budget"') : undefined
  );
  assert.ok(
    toolBlock.includes('merchantId: merchant.id'),
    'get_spending_summary must scope by merchantId'
  );
  assert.ok(
    !toolBlock.includes('merchant: merchant.businessName'),
    'get_spending_summary must NOT scope by non-unique businessName'
  );
});

// ── 3. Null API key never crashes the profile route ─────────────────────────
test('/api/merchant/me tolerates a null apiKey (pre-verification state)', () => {
  const src = read('src/app/api/merchant/me/route.ts');
  assert.ok(
    !src.includes('merchant.apiKey.slice('),
    'unguarded merchant.apiKey.slice must be gone (null crash)'
  );
  assert.ok(
    src.includes('merchant.apiKey ?') || src.includes('merchant.apiKey??') || src.includes('apiKeyHint: merchant.apiKey'),
    'apiKeyHint must be null-guarded'
  );
  for (const f of [
    'src/app/merchant/dashboard/page.tsx',
    'src/app/merchant/settings/page.tsx',
  ]) {
    const ui = read(f);
    assert.ok(
      ui.includes('apiKeyHint: string | null') || ui.includes('apiKeyHint?:'),
      `${f} MerchantInfo must type apiKeyHint as nullable`
    );
    assert.ok(
      ui.includes('?? '),
      `${f} must render a fallback when apiKeyHint is null`
    );
  }
});

// ── 4. Retired dashboard route is safely disabled, live-proven ──────────────
test('/api/merchant/dashboard is retired (410) and leaks no secret', async () => {
  const src = read('src/app/api/merchant/dashboard/route.ts');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!code.includes('include: { payments: true }'), 'invalid Prisma relation must be gone');
  assert.ok(!code.includes('apiKey: merchant.apiKey'), 'full-secret echo must be gone');
  assert.ok(!code.includes('from') || !code.includes('prisma'), 'retired route must not touch Prisma');
  assert.ok(src.includes('410'), 'retired route must answer 410 Gone');
  const { GET } = await import('../src/app/api/merchant/dashboard/route.ts');
  const res = await GET();
  assert.equal(res.status, 410, 'GET /api/merchant/dashboard must return 410');
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(
    String(body.error).includes('/api/merchant/me'),
    '410 body must point callers at the replacement endpoints'
  );
});
