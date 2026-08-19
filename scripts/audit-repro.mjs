// scripts/audit-repro.mjs
// Exploit reproduction + closed-proof for the 2026-08-19 audit-fix batch:
//
//   EXPLOIT 1 (C1 escape hatch): a self-registered merchant creates a
//   payment-link row ('pending@checkout' payer) and settles it with its own
//   merchant key — Path B debits the shared DEFAULT_PAYER_WALLET_ID and
//   pays the merchant's payout wallet. Repro: fresh attacker merchant →
//   payment-link row → merchant-key settle. Closed-proof: 403 with the
//   payer-control message, row untouched (stays PENDING, no lock flip), no
//   arcTxHash/circleTxId. The public /api/checkout/pay door is also gone
//   (404), and the internal key gets the same 403 on this row.
//
//   EXPLOIT 2 (cross-tenant agent control): the internal service key (the
//   brain's credential) could claim ANY AgentRegistry SCA as its own via
//   the ApiKey branch of wallet/verifyCallerControlsAddress — an LLM prompt
//   could schedule recurring debits or execute jobs against another
//   tenant's agent wallet. Repro: internal key schedules a recurring
//   payment with payerSCA = another merchant's registered agent.
//   Closed-proof: 403, no ScheduledPayment row created; a merchant key on
//   the same victim agent also 403; positive control (internal key +
//   AGENT_OWNER_WALLET_ADDRESS) still works.
//
//   STATIC PROOFS: brain tool schemas/executors expose no payer/wallet
//   fields; settle has no DEFAULT_PAYER_SCA fallback and no merchant
//   non-address branch; wallet check's ApiKey branch is platform-agent-only.
//
// Usage: node scripts/audit-repro.mjs [baseUrl]

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const INTERNAL_KEY = process.env.INTERNAL_SETTLEMENT_API_KEY;
const PLATFORM_AGENT = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
const AMOUNT = 0.01;

// Next.js loads .env.local over .env — sign the dashboard cookie with the
// SAME secret the dev server verifies with (the two files differ).
function envLocalValue(name) {
  for (const file of ['.env.local', '.env']) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
      if (m) return m[1].replace(/"|'/g, '');
    } catch { /* missing file */ }
  }
  return undefined;
}
const MERCHANT_JWT_SECRET = envLocalValue('MERCHANT_JWT_SECRET');
const devEnvValues = {
  AGENT_OWNER_WALLET_ADDRESS: envLocalValue('AGENT_OWNER_WALLET_ADDRESS'),
  AGENT_OWNER_WALLET_ID: envLocalValue('AGENT_OWNER_WALLET_ID'),
  AGENT_VALIDATOR_WALLET_ADDRESS: envLocalValue('AGENT_VALIDATOR_WALLET_ADDRESS'),
};

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures = [];
const cleanupRefs = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function j(res) {
  try { return await res.json(); } catch { return {}; }
}

async function post(path, body, headers = {}, timeoutMs = 180000) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/payments/verify/__probe__`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ── EXPLOIT 1 ─────────────────────────────────────────────────────────────
async function exploit1() {
  console.log('\n═══ EXPLOIT 1: merchant drains the platform default payer ═══');
  console.log('(repro: fresh merchant → payment-link row → merchant-key settle)');

  const attackerAddress = `0x${'dead'.repeat(10)}`;
  const attacker = await prisma.merchant.create({
    data: {
      email: `attacker_${Date.now()}@test.local`,
      businessName: 'Attacker Store',
      passwordHash: 'x',
      apiKey: `arc_live_repro_${Date.now()}`,
      verified: true,
      active: true,
      walletAddress: attackerAddress,
    },
  });
  ok('fresh self-registered attacker merchant created (verified + active + apiKey + payout wallet)', !!attacker.id);
  const attackerKey = attacker.apiKey;

  // The exact chain the audit used: dashboard session → payment link →
  // 'pending@checkout' row owned by the attacker merchant.
  const attackerCookie = await new SignJWT({ merchantId: attacker.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(MERCHANT_JWT_SECRET));
  const link = await post('/api/merchant/payment-link', {
    amount: AMOUNT, currency: 'USDC', description: 'audit-repro drain',
  }, { cookie: `merchant_token=${attackerCookie}` });
  const linkData = await j(link);
  ok('payment-link created a row with the attacker merchant', link.status === 200 && !!linkData.reference, `got ${link.status}: ${JSON.stringify(linkData).slice(0, 200)}`);
  const ref = linkData.reference;
  cleanupRefs.push(ref);
  let row = await prisma.paymentLog.findUnique({ where: { reference: ref } });
  ok('row payer = pending@checkout (the exploit shape)', row?.senderEmail === 'pending@checkout', row?.senderEmail);

  // THE OLD DRAIN: settle with the merchant's own key → Path B would debit
  // DEFAULT_PAYER_WALLET_ID and credit attackerAddress. Must now 403.
  const before = await prisma.paymentLog.findUnique({ where: { reference: ref } });
  const settle = await post('/api/payments/settle', { reference: ref }, { 'x-api-key': attackerKey });
  const settleData = await j(settle);
  ok('merchant-key settle of own link row → 403', settle.status === 403, `got ${settle.status}: ${JSON.stringify(settleData).slice(0, 200)}`);
  ok('rejection is the payer-control guard message', typeof settleData.error === 'string' && settleData.error.includes('payer is a wallet you do not control'), JSON.stringify(settleData).slice(0, 200));
  row = await prisma.paymentLog.findUnique({ where: { reference: ref } });
  ok('row untouched: still PENDING (no lock flip, no SUCCESS)', row?.status === 'PENDING' && before?.status === 'PENDING', `status ${row?.status}`);
  ok('no funds moved (no arcTxHash, no circleTxId)', !row?.arcTxHash && !row?.circleTxId, JSON.stringify({ arcTxHash: row?.arcTxHash, circleTxId: row?.circleTxId }));

  // The deleted public door (was the unauthenticated trigger of the drain).
  const oldDoor = await post('/api/checkout/pay', { reference: ref });
  ok('/api/checkout/pay route deleted → 404', oldDoor.status === 404, `got ${oldDoor.status}`);

  // Internal key on the same row: also 403 (internal key may only settle
  // the platform agent as payer).
  const internal = await post('/api/payments/settle', { reference: ref }, { 'x-api-key': INTERNAL_KEY });
  const internalData = await j(internal);
  ok('internal-key settle of the same row → 403', internal.status === 403, `got ${internal.status}: ${JSON.stringify(internalData).slice(0, 200)}`);

  // And a merchant key can no longer settle ANY 'pending@checkout' row —
  // including one it owns — against the platform default wallet.
  const link2 = await post('/api/merchant/payment-link', {
    amount: AMOUNT, currency: 'USDC',
  }, { cookie: `merchant_token=${attackerCookie}` });
  const ref2 = (await j(link2)).reference;
  cleanupRefs.push(ref2);
  const settle2 = await post('/api/payments/settle', { reference: ref2 }, { 'x-api-key': attackerKey });
  const settle2Data = await j(settle2);
  ok('second link row also 403 (branch fully removed, not payer-specific)', settle2.status === 403, `got ${settle2.status}: ${JSON.stringify(settle2Data).slice(0, 200)}`);

  await prisma.merchant.delete({ where: { id: attacker.id } }).catch(() => { });
  console.log('  (attacker merchant deleted)');
}

// ── EXPLOIT 2 ─────────────────────────────────────────────────────────────
async function exploit2() {
  console.log('\n═══ EXPLOIT 2: cross-tenant agent control via the service key ═══');
  console.log('(repro: internal key claims another tenant\'s AgentRegistry SCA)');

  // Victim: an existing registered agent that is NOT the platform's.
  const agents = await prisma.agentRegistry.findMany({
    where: { circleWalletId: { not: null } },
    orderBy: { id: 'asc' },
  });
  const victim = agents.find(
    (a) => a.scaAddress?.toLowerCase() !== PLATFORM_AGENT
  );
  ok('victim agent found (registered, has a Circle wallet, not the platform agent)', !!victim, JSON.stringify(victim ? { id: victim.id, name: victim.name, scaAddress: victim.scaAddress } : null));

  // THE OLD DRAIN: internal key + victim's SCA → ApiKey branch claimed any
  // AgentRegistry SCA → a ScheduledPayment row debiting the victim's wallet
  // every interval (an LLM prompt could trigger this via setup_agent_subscription).
  const evil = await post('/api/payments/scheduled', {
    payerSCA: victim.scaAddress,
    receiverSCA: `0x${'e'.repeat(40)}`,
    amount: '5.0',
    intervalDays: 1,
    description: 'audit-repro cross-tenant debit',
    startImmediately: false,
  }, { 'x-api-key': INTERNAL_KEY });
  const evilData = await j(evil);
  ok('internal-key schedule against victim agent → 403', evil.status === 403, `got ${evil.status}: ${JSON.stringify(evilData).slice(0, 200)}`);
  ok('rejection is the caller-control message', typeof evilData.error === 'string' && evilData.error.includes('You do not control the payer wallet'), JSON.stringify(evilData).slice(0, 200));
  const evilRows = await prisma.scheduledPayment.count({ where: { description: 'audit-repro cross-tenant debit' } });
  ok('no ScheduledPayment row created', evilRows === 0, `rows ${evilRows}`);

  // A merchant key of an unrelated merchant on the same victim agent: 403.
  const otherMerchant = await prisma.merchant.findFirst({
    where: { verified: true, active: true, apiKey: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const mEvil = await post('/api/payments/scheduled', {
    payerSCA: victim.scaAddress,
    receiverSCA: `0x${'e'.repeat(40)}`,
    amount: '5.0',
    intervalDays: 1,
    startImmediately: false,
  }, { 'x-api-key': otherMerchant.apiKey });
  const mEvilData = await j(mEvil);
  ok('unrelated merchant-key schedule against victim agent → 403', mEvil.status === 403, `got ${mEvil.status}: ${JSON.stringify(mEvilData).slice(0, 200)}`);

  // POSITIVE CONTROL: the internal key on the platform's own agent still
  // works — this is the legitimate brain subscription flow.
  const legit = await post('/api/payments/scheduled', {
    payerSCA: PLATFORM_AGENT,
    receiverSCA: `0x${'e'.repeat(40)}`,
    amount: '0.01',
    intervalDays: 30,
    description: 'audit-repro positive control',
    startImmediately: false,
  }, { 'x-api-key': INTERNAL_KEY });
  const legitData = await j(legit);
  ok('positive control: internal key + platform agent → 200', legit.status === 200, `got ${legit.status}: ${JSON.stringify(legitData).slice(0, 200)}`);
  ok('ScheduledPayment row created for the platform agent', !!legitData.scheduledPayment?.reference, JSON.stringify(legitData).slice(0, 200));
  await prisma.scheduledPayment.delete({
    where: { reference: legitData.scheduledPayment.reference },
  }).catch(() => { });
  console.log('  (positive-control schedule deleted)');

  // The same shape through the brain: setup_agent_subscription with a
  // tenant agent's SCA as payer is no longer expressible — the tool schema
  // has no payerSCA field at all (verified statically below).
}

// ── STATIC PROOFS ─────────────────────────────────────────────────────────
function staticProofs() {
  console.log('\n═══ STATIC PROOFS (code-level) ═══');
  const root = process.cwd();
  const settleSrc = fs.readFileSync(`${root}/src/app/api/payments/settle/route.ts`, 'utf8');
  const brainSrc = fs.readFileSync(`${root}/src/app/api/agent/brain/route.ts`, 'utf8');
  const walletCheckSrc = fs.readFileSync(`${root}/src/lib/wallet/verifyCallerControlsAddress.ts`, 'utf8');
  const initializeSrc = fs.readFileSync(`${root}/src/app/api/payments/initialize/route.ts`, 'utf8');

  // settle: no shared-default fallback payer; fail-closed wallet resolution.
  ok('settle: DEFAULT_PAYER_SCA constant removed', !/DEFAULT_PAYER_SCA/.test(settleSrc));
  ok('settle: fail-closed Path B (refuses shared default for non-platform payers)',
    /refusing to debit a shared default wallet/.test(settleSrc) &&
    /payerSCA\.toLowerCase\(\) !== platformAgent/.test(settleSrc));
  ok('settle: no merchant non-address (pending@checkout) settle branch',
    !/else if \(callerMerchant && merchantOwnsIt\)\s*\{\s*payerAuthorized = true/.test(settleSrc));
  ok('settle: guard runs before the atomic lock',
    /preflight/.test(settleSrc) && /BEFORE taking the lock/.test(settleSrc));

  // brain: no LLM-controlled payer/wallet fields survive in schemas/executors.
  const badBrainFields = /input\.(clientSCA|clientWalletId|payerSCA|payerWalletId|senderSCA|senderWalletId|evaluatorWalletId|validatorWalletAddress)\b/;
  const badBrainSchemaProps = /"(clientSCA|clientWalletId|payerSCA|payerWalletId|senderSCA|senderWalletId|evaluatorWalletId|validatorWalletAddress)"/;
  ok('brain: executors no longer read LLM payer/wallet inputs', !badBrainFields.test(brainSrc));
  ok('brain: tool schemas no longer expose payer/wallet fields', !badBrainSchemaProps.test(brainSrc));

  // wallet check: ApiKey branch is platform-agent-only.
  ok('wallet check: ApiKey branch scoped to AGENT_OWNER_WALLET_ADDRESS',
    /An API key does NOT grant control of an arbitrary AgentRegistry address/.test(walletCheckSrc) &&
    /normalized === platformAgent/.test(walletCheckSrc));

  // initialize: platform agent usable by internal callers without a row.
  ok('initialize: platform agent exempt from registry lookup for internal callers',
    /isPlatformAgent/.test(initializeSrc) && /caller\.type === 'internal'/.test(initializeSrc));
}

async function main() {
  console.log('── Audit-Fix Exploit Reproduction ───────────────────────────');
  console.log(`base: ${BASE}`);

  if (!(await waitForServer())) {
    console.log(`❌ dev server not reachable at ${BASE}`);
    process.exit(1);
  }
  ok('internal key available (INTERNAL_SETTLEMENT_API_KEY)', !!INTERNAL_KEY);
  ok('platform agent configured (AGENT_OWNER_WALLET_ADDRESS)', !!PLATFORM_AGENT);

  staticProofs();
  await exploit1();
  await exploit2();

  // Cleanup any leftover repro rows.
  for (const ref of cleanupRefs) {
    await prisma.paymentLog.delete({ where: { reference: ref } }).catch(() => { });
  }
  await prisma.scheduledPayment.deleteMany({ where: { description: { contains: 'audit-repro' } } }).catch(() => { });
  await prisma.paymentLog.deleteMany({ where: { description: { contains: 'audit-repro' } } }).catch(() => { });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f.name} — ${f.detail || ''}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('repro harness error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
