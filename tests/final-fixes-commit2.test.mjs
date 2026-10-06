// tests/final-fixes-commit2.test.mjs — final-fix pass, commit 2 regression suite.
//
// Covers: payment-link tenant scoping (merchantId, never businessName),
// /api/payments detail auth + minimal projection (public checkout verify
// untouched), treasury-hire claim-before-action, agent-pay mandatory
// idempotency, Brain CTA consistency, production console-noise removal.
//
// Static only (no DB/chain/network). Run: node --test tests/final-fixes-commit2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
// Production sources with `//` line comments stripped so historical/
// explanatory mentions in comments are never mistaken for code.
const readCode = (f) =>
  read(f)
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');

// ── 1. Payment-link GET scoped by merchantId ───────────────────────────────
test('payment-link GET scopes by authenticated merchantId, never businessName', () => {
  const src = readCode('src/app/api/merchant/payment-link/route.ts');
  const getBody = src.split('export async function GET')[1];
  assert.ok(getBody, 'GET handler must exist');
  assert.match(getBody, /where:\s*{\s*merchantId:\s*merchant\.id\s*}/);
  assert.ok(
    !/where:\s*{\s*merchant:\s*merchant\.businessName\s*}/.test(getBody),
    'GET must not scope by businessName (not unique, never an auth boundary)'
  );
});

// ── 2. /api/payments detail: auth + tenant scope + minimal projection ─────
test('payments detail requires merchant auth and scopes by merchantId', () => {
  const src = readCode('src/app/api/payments/route.ts');
  assert.match(src, /resolveMerchant\(request\)/);
  assert.match(src, /status:\s*401/);
  assert.match(src, /findFirst\(\{\s*where:\s*{\s*id,\s*merchantId:\s*authed\.id\s*}\s*\}\)/);
});

test('payments detail projection exposes only merchant-safe fields', () => {
  const src = readCode('src/app/api/payments/route.ts');
  for (const secret of [
    'webhookUrl', 'gatewayReference', 'circleTxId', 'idempotencyKey',
    'payerSCA', 'agentSCA', 'senderEmail', 'merchantSCA', 'upstreamOk', 'upstreamStatus',
  ]) {
    assert.ok(!src.includes(secret), `projection must never expose ${secret}`);
  }
  for (const kept of ['reference', 'amount', 'currency', 'status', 'arcTxHash', 'expiresAt']) {
    assert.ok(src.includes(kept), `projection must keep merchant-needed field ${kept}`);
  }
});

test('public checkout verification stays public (checkout keeps working)', () => {
  const src = readCode('src/app/api/payments/verify/[reference]/route.ts');
  assert.ok(!src.includes('resolveMerchant'), 'verify/[reference] must stay public for checkout polling');
  assert.ok(!src.includes('withMerchantAuth'), 'verify/[reference] must stay public for checkout polling');
  assert.match(src, /findUnique\(\{\s*where:\s*{\s*reference\s*}/);
});

// ── 3. Treasury-hire claim-before-action ────────────────────────────────────
test('treasury-hire claims idempotency BEFORE the on-chain write and releases on failure', () => {
  const src = readCode('src/app/api/agents/[id]/treasury/hire/route.ts');
  const claimIdx = src.indexOf("status: 'PROCESSING'");
  const submitIdx = src.indexOf('createContractExecutionTransaction');
  assert.ok(claimIdx !== -1 && submitIdx !== -1 && claimIdx < submitIdx,
    'the PROCESSING claim must be written before the Circle submission');
  assert.match(src, /paymentLog\.delete\(\{\s*where:\s*{\s*idempotencyKey:\s*hireIdemKey\s*}\s*\}\)/,
    'external-action failure must release the claim so retries can proceed');
});

// ── 4. Agent-pay mandatory idempotency ──────────────────────────────────────
test('agent-pay rejects keyless requests and releases the claim when no money moved', () => {
  const src = readCode('src/lib/agents/agentPay.ts');
  assert.match(src, /idempotencyKey \(1-120 chars\) is required/);
  assert.match(src, /status:\s*400/);
  const releases = src.match(/await releaseClaim\(\);/g) ?? [];
  assert.equal(releases.length, 3, `expected 3 pre-transfer claim releases, got ${releases.length}`);
  // Post-record failures still require a NEW key (money may have moved).
  assert.ok(src.includes('retry with a NEW idempotency key'),
    'SETTLEMENT_ERROR replay must still require a fresh key');
});

test('agent-pay e2e covers the mandatory-key contract', () => {
  const e2e = read('scripts/agent-pay-e2e.ts');
  assert.ok(e2e.includes('without idempotencyKey → 400'), 'e2e must assert keyless rejection');
  assert.ok(e2e.includes('released claim leaves no stranded row'), 'e2e must assert claim release');
});

// ── 5. Brain CTA consistency (no homepage redesign) ─────────────────────────
test('Brain entry points agree the surface is available', () => {
  const sidebar = read('src/components/DashboardSidebar.tsx');
  assert.ok(!/Agent Brain.*disabled:\s*true/.test(sidebar), 'sidebar must not mark Agent Brain unavailable');
  assert.ok(sidebar.includes("href: '/agent-brain'"), 'sidebar must link the live destination');
  const rail = read('src/components/home/AgentRail.tsx');
  assert.ok(rail.includes("href: '/agent-brain'"), 'homepage CTA still routes to the live destination');
  const home = read('src/app/page.tsx');
  assert.ok(home.includes('AgentRail'), 'homepage structure untouched');
});

// ── 6. Production console noise ─────────────────────────────────────────────
test('no debug-only console output in production client paths', () => {
  const bridge = readCode('src/components/bridge/ExternalBridge.tsx');
  assert.ok(!bridge.includes('console.log'), 'ExternalBridge must not console.log in production');
  assert.ok(bridge.includes('if (!BRIDGE_DIAG_ENABLED) return;'), 'bridgeTrace must be dev-gated');
  assert.ok(bridge.includes('console.error'), 'operational error logging must stay');
  const panel = readCode('src/components/PendingSignaturesPanel.tsx');
  assert.ok(!panel.includes('console.debug'), 'PendingSignaturesPanel must not console.debug');
  assert.ok(panel.includes('console.error'), 'operational error logging must stay');
});
