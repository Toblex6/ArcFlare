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
//   EXPLOIT 3 (scheduled/run shared-default drain — the C1 survivor):
//   a scheduled row with payerWalletId null used to pay receiverSCA from
//   DEFAULT_PAYER_WALLET_ID at every tick (creation persisted null for
//   agent/merchant payers; the brain's setup_agent_subscription produced
//   exactly this shape). Closed-proof: a poisoned null-wallet row is
//   REFUSED by /scheduled/run (receiver balance provably unchanged), and
//   creation now resolves the payer's bound wallet (consumer/merchant/
//   registered agent/platform agent) and refuses to persist what it cannot
//   bind.
//
//   EXPLOIT 4 (nano assignment-default drain — the C1-class variant):
//   /api/payments/nano/settle used `let payerWalletId =
//   DEFAULT_PAYER_WALLET_ID` with a conditional override — the assignment-
//   default shape, invisible to the `|| DEFAULT` regex. Any caller who
//   controlled EITHER party could POST /api/payments/nano with agentSCA =
//   the platform default payer SCA (0x7a8214…), then force-settle the pair
//   to drain the shared platform wallet to their own merchantSCA.
//   Closed-proof: merchant-key nano create → 403 (payer-side control
//   required, default payer internal-only); a poisoned pre-existing row
//   force-settled by a merchant key → 403, row untouched, receiver
//   on-chain balance provably unchanged; mixed-case default SCA → 403
//   (case-insensitive identity); internal key still passes the guard and
//   resolves the default wallet (fail-closed on empty batch, no funds
//   moved).
//
//   STATIC PROOFS: brain tool schemas/executors expose no payer/wallet
//   fields (regex matches the codebase's real unquoted schema syntax and
//   includes evaluatorSCA); settle has no DEFAULT_PAYER_SCA fallback and no
//   merchant non-address branch; scheduled/run has no DEFAULT fallback and
//   fails closed on null; nano/settle has no assignment-default initializer
//   (only the internal-key-gated explicit binding) and no either-party
//   guard; wallet check's ApiKey branch is platform-agent-only.
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
  // The wallet must be EXPLICITLY resolved at creation — a null
  // payerWalletId is the exact field that used to fall through to the
  // shared default at run time (the C1-class drain).
  const platformWallet = await platformAgentWalletId();
  ok('positive control: payerWalletId explicitly resolved (non-null)', !!legitData.scheduledPayment?.payerWalletId, `payerWalletId ${JSON.stringify(legitData.scheduledPayment?.payerWalletId)}`);
  ok('positive control: payerWalletId = settle\'s platform-agent wallet (same convention)', legitData.scheduledPayment?.payerWalletId === platformWallet, `row ${legitData.scheduledPayment?.payerWalletId} vs settle ${platformWallet}`);
  await prisma.scheduledPayment.delete({
    where: { reference: legitData.scheduledPayment.reference },
  }).catch(() => { });
  console.log('  (positive-control schedule deleted)');

  // The same shape through the brain: setup_agent_subscription with a
  // tenant agent's SCA as payer is no longer expressible — the tool schema
  // has no payerSCA field at all (verified statically below).
}

// The platform agent's signing wallet per settle/route.ts Path B convention
// (grep'd live from the source so this cannot drift from the code).
async function platformAgentWalletId() {
  const settleSrc = fs.readFileSync(`${process.cwd()}/src/app/api/payments/settle/route.ts`, 'utf8');
  const m = settleSrc.match(/const DEFAULT_PAYER_WALLET_ID = '([0-9a-f-]+)'/);
  return m ? m[1] : null;
}

// ── EXPLOIT 3: scheduled/run default-wallet drain (C1 survivor) ─────────────
async function exploit3() {
  console.log('\n═══ EXPLOIT 3: scheduled/run shared-default-wallet drain ═══');
  console.log('(repro: brain setup_agent_subscription shape + a null-wallet row tick)');

  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const USDC = '0x3600000000000000000000000000000000000000';
  async function erc20Balance(address) {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: USDC, data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}` }, 'latest'],
      }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error.message);
    return BigInt(out.result);
  }

  // (a) THE OLD DRAIN ROW SHAPE: a scheduled payment whose payerWalletId
  // is null (pre-fix creation persisted null for agent/merchant payers).
  // /scheduled/run used to pay `payerWalletId || DEFAULT_PAYER_WALLET_ID` —
  // debiting the shared platform wallet for whoever the (model-controlled)
  // receiverSCA said. Post-fix: run must refuse, and no funds may move.
  const receiver = `0x${'f'.repeat(40)}`;
  const before = await erc20Balance(receiver);
  const poisoned = await prisma.scheduledPayment.create({
    data: {
      reference: `sched_repro_null_${Date.now()}`,
      payerSCA: PLATFORM_AGENT,
      payerWalletId: null,
      receiverSCA: receiver,
      amount: 1.0,
      intervalDays: 1,
      nextRunAt: new Date(Date.now() - 60_000),
      description: 'audit-repro null-wallet run',
      status: 'ACTIVE',
    },
  });
  ok('poisoned null-payerWalletId row created (legacy shape)', !!poisoned.id);

  const runRes = await post('/api/payments/scheduled/run', {}, { 'x-api-key': INTERNAL_KEY });
  const runData = await j(runRes);
  console.log(`  /scheduled/run → ${runRes.status}: ${JSON.stringify(runData).slice(0, 300)}`);
  ok('run route responds 200 (per-row results)', runRes.status === 200, `got ${runRes.status}`);
  const mine = (runData.results || []).find((r) => r.reference === poisoned.reference);
  ok('poisoned row reported FAILED (not executed)', mine && mine.success === false, JSON.stringify(mine));
  ok('failure reason = no resolved payer wallet', mine && typeof mine.error === 'string' && mine.error.includes('no resolved payer wallet'), JSON.stringify(mine));
  const after = await erc20Balance(receiver);
  ok('no funds moved: receiver balance unchanged (0)', before === after && before === 0n, `before ${before} after ${after}`);
  await prisma.scheduledPayment.delete({ where: { reference: poisoned.reference } }).catch(() => { });

  // (b) CREATION FAIL-CLOSED: a payer with no Circle-custodied wallet
  // bound to it can no longer persist a schedule at all (pre-fix this
  // persisted payerWalletId: null and drained the default at run time).
  const bareMerchant = await prisma.merchant.create({
    data: {
      email: `bare_${Date.now()}@test.local`,
      businessName: 'Bare Wallet Store',
      passwordHash: 'x',
      apiKey: `arc_live_repro_bare_${Date.now()}`,
      verified: true,
      active: true,
      walletAddress: `0x${'9'.repeat(40)}`,
      circleWalletId: null,
    },
  });
  const bareCreate = await post('/api/payments/scheduled', {
    payerSCA: bareMerchant.walletAddress,
    receiverSCA: receiver,
    amount: '1.0',
    intervalDays: 1,
    startImmediately: false,
  }, { 'x-api-key': bareMerchant.apiKey });
  const bareData = await j(bareCreate);
  ok('merchant payer without bound Circle wallet → 400 at creation', bareCreate.status === 400, `got ${bareCreate.status}: ${JSON.stringify(bareData).slice(0, 200)}`);
  ok('rejection = refusing to persist an unbound schedule', typeof bareData.error === 'string' && bareData.error.includes('refusing to persist'), JSON.stringify(bareData).slice(0, 200));
  const bareRows = await prisma.scheduledPayment.count({ where: { payerSCA: bareMerchant.walletAddress } });
  ok('no ScheduledPayment row persisted', bareRows === 0, `rows ${bareRows}`);
  await prisma.merchant.delete({ where: { id: bareMerchant.id } }).catch(() => { });
  console.log('  (bare-wallet merchant deleted)');
}

// ── EXPLOIT 4: nano assignment-default drain (C1-class variant) ─────────────
async function exploit4() {
  console.log('\n═══ EXPLOIT 4: nano/settle assignment-default wallet drain ═══');
  console.log('(repro: agentSCA = platform default payer + own merchantSCA → force-settle)');

  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const USDC = '0x3600000000000000000000000000000000000000';
  async function erc20Balance(address) {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: USDC, data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}` }, 'latest'],
      }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error.message);
    return BigInt(out.result);
  }

  const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';

  const attacker = await prisma.merchant.create({
    data: {
      email: `nano_attacker_${Date.now()}@test.local`,
      businessName: 'Nano Attacker Store',
      passwordHash: 'x',
      apiKey: `arc_live_nano_repro_${Date.now()}`,
      verified: true,
      active: true,
      walletAddress: `0x${'d'.repeat(40)}`,
    },
  });
  const attackerKey = attacker.apiKey;
  ok('fresh nano attacker merchant created', !!attacker.id);

  // (a) THE OLD CHAIN STEP 1: record a charge whose PAYER is the platform
  // default wallet, receiver = attacker's own merchant wallet. The old
  // either-party guard accepted this because the attacker controls
  // merchantSCA. Post-fix: payer-side control required → 403.
  const createRes = await post('/api/payments/nano', {
    agentSCA: DEFAULT_PAYER_SCA,
    merchantSCA: attacker.walletAddress,
    amount: '0.0001',
    description: 'audit-repro nano drain',
  }, { 'x-api-key': attackerKey });
  const createData = await j(createRes);
  ok('merchant-key nano create with platform default payer → 403', createRes.status === 403, `got ${createRes.status}: ${JSON.stringify(createData).slice(0, 200)}`);
  ok('rejection = payer-control guard message', typeof createData.error === 'string' && createData.error.includes('You do not control the payer (agentSCA)'), JSON.stringify(createData).slice(0, 200));
  const createRows = await prisma.nanoPayment.count({ where: { agentSCA: DEFAULT_PAYER_SCA, merchantSCA: attacker.walletAddress } });
  ok('no NanoPayment row created', createRows === 0, `rows ${createRows}`);

  // (b) THE OLD CHAIN STEP 2 (even with a pre-existing row — e.g. one
  // recorded before the fix): force-settle the pair with a merchant key.
  // Old settleOnchain resolved payerWalletId = DEFAULT_PAYER_WALLET_ID and
  // drained it. Post-fix: merchant key → 403 at the guard, row untouched.
  const poisoned = await prisma.nanoPayment.create({
    data: {
      agentSCA: DEFAULT_PAYER_SCA,
      merchantSCA: attacker.walletAddress,
      amount: 0.5,
      description: 'audit-repro nano drain (pre-existing row)',
      settled: false,
    },
  });
  ok('poisoned pre-existing NanoPayment row created', !!poisoned.id);
  const before = await erc20Balance(attacker.walletAddress);

  const settleRes = await post('/api/payments/nano/settle', {
    agentSCA: DEFAULT_PAYER_SCA,
    merchantSCA: attacker.walletAddress,
    forceSettle: true,
  }, { 'x-api-key': attackerKey });
  const settleData = await j(settleRes);
  ok('merchant-key force-settle of default-payer pair → 403', settleRes.status === 403, `got ${settleRes.status}: ${JSON.stringify(settleData).slice(0, 200)}`);
  ok('rejection = payer-control guard message', typeof settleData.error === 'string' && settleData.error.includes('You do not control the payer (agentSCA)'), JSON.stringify(settleData).slice(0, 200));
  const rowAfter = await prisma.nanoPayment.findUnique({ where: { id: poisoned.id } });
  ok('row untouched: still unsettled, no batchRef', rowAfter?.settled === false && rowAfter?.batchRef === null, JSON.stringify({ settled: rowAfter?.settled, batchRef: rowAfter?.batchRef }));
  const after = await erc20Balance(attacker.walletAddress);
  ok('no funds moved: receiver balance unchanged', before === after, `before ${before} after ${after}`);

  // (c) CASE-SENSITIVITY: scaAddress preserves casing — a mixed-case
  // variant of the default payer must NOT bypass the identity check.
  const mixed = await post('/api/payments/nano', {
    agentSCA: `0x7A8214DAD7630A7A39054E0121ACDBC7A65821C9`,
    merchantSCA: attacker.walletAddress,
    amount: '0.0001',
    description: 'audit-repro nano drain (mixed case)',
  }, { 'x-api-key': attackerKey });
  ok('mixed-case default payer SCA → 403 (case-insensitive identity)', mixed.status === 403, `got ${mixed.status}: ${JSON.stringify(await j(mixed)).slice(0, 200)}`);

  // (d) POSITIVE CONTROL: the internal service key is the ONLY caller that
  // may settle for the platform default payer. The poisoned row is gone by
  // now, so settleOnchain resolves the default wallet then fails closed on
  // the empty batch — proving the internal path is NOT blocked without
  // actually moving funds.
  await prisma.nanoPayment.delete({ where: { id: poisoned.id } }).catch(() => { });
  const internalRes = await post('/api/payments/nano/settle', {
    agentSCA: DEFAULT_PAYER_SCA,
    merchantSCA: attacker.walletAddress,
    forceSettle: true,
  }, { 'x-api-key': INTERNAL_KEY });
  const internalData = await j(internalRes);
  ok('internal-key settle of default-payer pair → NOT 403 (guard passes)',
    internalRes.status !== 403 && internalRes.status !== 401, `got ${internalRes.status}: ${JSON.stringify(internalData).slice(0, 200)}`);
  ok('internal path resolves default wallet, fails closed on empty batch',
    typeof internalData.error === 'string' && internalData.error.includes('No pending payments found'), JSON.stringify(internalData).slice(0, 200));

  await prisma.nanoPayment.deleteMany({ where: { description: { contains: 'audit-repro nano' } } }).catch(() => { });
  await prisma.merchant.delete({ where: { id: attacker.id } }).catch(() => { });
  console.log('  (poisoned row + attacker merchant deleted)');
}

// ── EXPLOIT 5 (H2): merchant api-key claims control of an arbitrary agent ──
async function exploit5() {
  console.log('\n═══ EXPLOIT 5: merchant api-key claims an arbitrary agent SCA ═══');
  console.log('(repro: api key → verifyCallerControlsAddress must NOT bless a SCA the merchant does not own)');

  // Use an existing registered agent that the attacker merchant does NOT own
  // (ownerNode is required non-null — any row qualifies as a victim).
  const victim = await prisma.agentRegistry.findFirst({ orderBy: { id: 'asc' } });
  if (!victim) {
    ok('H2: (skip) no AgentRegistry row available for live cross-tenant claim', true, 'no agent rows');
    return;
  }

  const attacker = await prisma.merchant.create({
    data: {
      email: `h2_attacker_${Date.now()}@test.local`,
      businessName: 'H2 Attacker Store',
      passwordHash: 'x',
      apiKey: `arc_live_h2_repro_${Date.now()}`,
      verified: true,
      active: true,
      walletAddress: `0x${'e'.repeat(40)}`,
    },
  });
  const attackerKey = attacker.apiKey;

  // GET /api/agents/[id]/policy provisions the wallet and requires caller
  // control of the agent. A merchant key with NO relation to the agent must
  // get a 403, not the policy.
  const policyRes = await fetch(`${BASE}/api/agents/${victim.id}/policy`, {
    headers: { 'x-api-key': attackerKey },
  });
  const policyData = await j(policyRes);
  ok('merchant api-key GET policy on another tenant\'s agent → 403',
    policyRes.status === 403, `got ${policyRes.status}: ${JSON.stringify(policyData).slice(0, 200)}`);
  ok('rejection = caller-control message', typeof policyData.error === 'string' && policyData.error.includes('does not control this agent'),
    JSON.stringify(policyData).slice(0, 200));

  // The pay route is the money path — same guard, must 403 before anything moves.
  const payRes = await post(`/api/agents/${victim.id}/pay`, {
    to: attacker.walletAddress,
    amount: '0.0001',
  }, { 'x-api-key': attackerKey });
  const payData = await j(payRes);
  ok('merchant api-key pay from another tenant\'s agent → 403',
    payRes.status === 403, `got ${payRes.status}: ${JSON.stringify(payData).slice(0, 200)}`);
  ok('pay rejection = caller-control message', typeof payData.error === 'string' && payData.error.includes('does not control this agent'),
    JSON.stringify(payData).slice(0, 200));

  await prisma.merchant.delete({ where: { id: attacker.id } }).catch(() => { });
  console.log('  (attacker merchant deleted)');
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
  // Schema properties are UNQUOTED in this codebase (clientSCA: {...}) and
  // the schema props are the ones with OBJECT values (`{ type: ... }`), so
  // the property regex anchors on `\s*:\s*{` — executor payload keys
  // (`payerSCA: process.env…`) don't match. A quoted-only or unanchored
  // regex can never fire or false-fires — both were Opus 5 findings.
  const BAD_FIELDS =
    'clientSCA|clientWalletId|payerSCA|payerWalletId|senderSCA|senderWalletId|evaluatorWalletId|validatorWalletAddress';
  // evaluatorSCA is deliberately NOT in the global lists: create_agent_job
  // legitimately lets the client name the judge of the job. The flagged
  // tool was complete_or_reject_job (the executor SIGNING as evaluator) —
  // that is scoped-checked below.
  const badBrainFields = new RegExp(`input\\.(${BAD_FIELDS})\\b`);
  const badBrainSchemaProps = new RegExp(`^\\s*(${BAD_FIELDS})\\s*:\\s*\\{`, 'm');
  ok('brain: executors no longer read LLM payer/wallet inputs', !badBrainFields.test(brainSrc));
  ok('brain: tool schemas no longer expose payer/wallet fields', !badBrainSchemaProps.test(brainSrc));

  // complete_or_reject_job: evaluator identity pinned server-side.
  const completeTool = brainSrc.match(/name: "complete_or_reject_job"[\s\S]*?\n  \},/)?.[0] || '';
  const completeCase = brainSrc.match(/case "complete_or_reject_job":[\s\S]*?\n    \}/)?.[0] || '';
  ok('brain: complete_or_reject_job schema exposes NO evaluator fields', !/evaluatorSCA|evaluatorWalletId/.test(completeTool), completeTool.slice(0, 200));
  ok('brain: complete_or_reject_job executor reads NO input.evaluator*', !/input\.evaluator/.test(completeCase), completeCase.slice(0, 200));
  ok('brain: complete_or_reject_job evaluator pinned to the platform agent',
    /evaluatorSCA: process\.env\.AGENT_OWNER_WALLET_ADDRESS/.test(completeCase));

  // wallet check: ApiKey branch is platform-agent-only.
  ok('wallet check: ApiKey branch scoped to AGENT_OWNER_WALLET_ADDRESS',
    /An API key does NOT grant control of an arbitrary AgentRegistry address/.test(walletCheckSrc) &&
    /normalized === platformAgent/.test(walletCheckSrc));

  // initialize: platform agent usable by internal callers without a row.
  ok('initialize: platform agent exempt from registry lookup for internal callers',
    /isPlatformAgent/.test(initializeSrc) && /caller\.type === 'internal'/.test(initializeSrc));

  // scheduled: no shared-default fallback survives anywhere. The source
  // still *documents* the removed fallback in a comment (line ~35: "used
  // `payerWalletId || DEFAULT_PAYER_WALLET_ID` …"), so strip comments
  // before asserting — these checks must prove CODE state, not prose.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const runSrc = stripComments(fs.readFileSync(`${root}/src/app/api/payments/scheduled/run/route.ts`, 'utf8'));
  const createSrc = fs.readFileSync(`${root}/src/app/api/payments/scheduled/route.ts`, 'utf8');
  ok('scheduled/run: DEFAULT_PAYER_WALLET_ID constant gone', !/DEFAULT_PAYER_WALLET_ID/.test(runSrc));
  ok('scheduled/run: fails closed on null payerWalletId',
    /if \(!scheduled\.payerWalletId\)/.test(runSrc) &&
    /refusing to execute against a shared default/.test(runSrc));
  ok('scheduled/run: no `|| DEFAULT` fallback pattern', !/\|\|\s*DEFAULT_PAYER_WALLET_ID/.test(runSrc));
  ok('scheduled/create: resolves agent payers (AgentRegistry) at creation',
    /agentRegistry/.test(createSrc) && /controlsPayer\.type === 'agent'/.test(createSrc));
  ok('scheduled/create: refuses to persist unbound payers',
    /refusing to persist a recurring payment that cannot pay/.test(createSrc));
  ok('scheduled/create: body-supplied payerWalletId no longer accepted',
    !/^\s*payerWalletId,/m.test(createSrc));
  ok('scheduled/create: DEFAULT_PAYER_WALLET_ID only as explicit platform-agent binding',
    /DEFAULT_PAYER_WALLET_ID/.test(createSrc) &&
    /controlsPayer\.walletAddress\.toLowerCase\(\) === platformAgent/.test(createSrc));

  // nano: the C1-class ASSIGNMENT-DEFAULT shape (Opus 5 follow-up). The
  // old `let payerWalletId = DEFAULT_PAYER_WALLET_ID` initializer with a
  // conditional override was invisible to the `|| DEFAULT` regex — check
  // for the initializer form, the either-party guard, and the identity
  // comparison directly. The fixed code MAY still assign
  // DEFAULT_PAYER_WALLET_ID — but only inside the internal-key-gated
  // platform-default branch (the explicit binding, like scheduled/create).
  const nanoSettleSrc = fs.readFileSync(`${root}/src/app/api/payments/nano/settle/route.ts`, 'utf8');
  const nanoCreateSrc = fs.readFileSync(`${root}/src/app/api/payments/nano/route.ts`, 'utf8');
  const nanoSettleCode = stripComments(nanoSettleSrc);
  const nanoCreateCode = stripComments(nanoCreateSrc);
  ok('nano/settle: no `let payerWalletId = DEFAULT` initializer (assignment-default shape gone)',
    !/let payerWalletId\s*=\s*DEFAULT_PAYER_WALLET_ID/.test(nanoSettleCode));
  ok('nano/settle: DEFAULT only via internal-key-gated explicit binding',
    /payerWalletId = DEFAULT_PAYER_WALLET_ID/.test(nanoSettleCode) &&
    /if \(!isInternalServiceCall\)/.test(nanoSettleCode) &&
    /refusing to debit the shared platform default wallet/.test(nanoSettleCode));
  ok('nano/settle: platform-default identity compared case-insensitively',
    /agentSCANormalized === DEFAULT_PAYER_SCA\.toLowerCase\(\)/.test(nanoSettleCode));
  ok('nano/settle: AgentRegistry payer lookup case-insensitive',
    /scaAddress: \{ equals: agentSCA, mode: "insensitive" \}/.test(nanoSettleCode));
  ok('nano/settle: no either-party guard (merchantOwnsIt gone)',
    !/merchantOwnsIt/.test(nanoSettleCode) &&
    /You do not control the payer \(agentSCA\) of this settlement/.test(nanoSettleCode));
  ok('nano/create: no either-party guard (controlsMerchant gone)',
    !/controlsMerchant/.test(nanoCreateCode) &&
    /You do not control the payer \(agentSCA\) of this charge/.test(nanoCreateCode));
  ok('nano/create: platform default payer reachable only via internal key',
    /isInternalServiceCall && isPlatformDefaultPayer/.test(nanoCreateCode));
  const nanoUiSrc = fs.readFileSync(`${root}/src/app/nano/page.tsx`, 'utf8');
  ok('nano UI: agentSCA no longer prefilled with the platform default payer',
    !/useState\("0x7a8214dad7630a7a39054e0121acdbc7a65821c9"\)/.test(nanoUiSrc));

  // ── H2 (batch 5): verifyCallerControlsAddress callers all null-check ────
  // Every live call site must reject a null actor (defense in depth: the
  // helper itself already fails closed on null). Scan every src/ file that
  // calls it: strip comments, count CALLS vs `if (!x)` GUARDS, and require
  // guards >= calls in each file. Guard variable names differ per site
  // (actor / controlsPayer / requestActor / agentOwnsIt / …), so only the
  // `if (!` shape is counted — the number of guards must cover the calls.
  const h2Files = fs.readdirSync(`${root}/src`, { recursive: true })
    .filter((p) => typeof p === 'string' && p.endsWith('.ts'))
    .map((p) => `${root}/src/${p}`);
  const unguarded = [];
  let totalH2Calls = 0;
  for (const file of h2Files) {
    if (file.includes('verifyCallerControlsAddress.ts')) continue; // the helper itself — returns null
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const calls = (code.match(/verifyCallerControlsAddress\(/g) || []).length;
    if (calls === 0) continue;
    totalH2Calls += calls;
    // Guards take several shapes: `if (!actor)`, `if (!controlsPayer && …)`,
    // and inline `if (!(await verifyCallerControlsAddress(…)))`.
    const guards = (code.match(/if \(!(?:await\b|\w+)/g) || []).length;
    if (guards < calls) unguarded.push(`${file.split('/src/')[1]}: ${calls} calls, ${guards} guards`);
  }
  ok('H2: every caller rejects a null actor (guards >= calls in every file)',
    unguarded.length === 0 && totalH2Calls >= 8,
    `${totalH2Calls} calls, all guarded${unguarded.length ? ' — UNGUARDED: ' + unguarded.join('; ') : ''}`);
  ok('H2: nano/settle guard is payer-side (agentOwnsIt)',
    /You do not control the payer \(agentSCA\) of this settlement/.test(nanoSettleCode));

  // ── H3 (batch 5): default spend limit + front-run guard ─────────────────
  const enforcerSrc = fs.readFileSync(`${root}/src/lib/agents/spendLimitEnforcer.ts`, 'utf8');
  const x402Src = fs.readFileSync(`${root}/src/lib/x402-wallet.ts`, 'utf8');
  const agentPaySrc = fs.readFileSync(`${root}/src/lib/agents/agentPay.ts`, 'utf8');
  ok('H3: provisioning sets a default spend limit via the relayer',
    /ensureAgentDefaultSpendLimit/.test(enforcerSrc) &&
    /setLimit\(agentAddress, cap, BigInt\(DEFAULT_AGENT_SPEND_WINDOW_SECONDS\)\)/.test(enforcerSrc));
  ok('H3: provisioning hooks the default limit into wallet creation',
    /ensureAgentDefaultSpendLimit\(account\.address\)/.test(x402Src));
  ok('H3: setAgentPolicy refuses a front-run limit owner',
    /Spend-limit ownership for this agent was taken by another address/.test(agentPaySrc) &&
    /limit\.owner\.toLowerCase\(\) !== relayer\.toLowerCase\(\)/.test(agentPaySrc));
  ok('H3: checkAndRecordSpend is only reachable from backend-signed callers',
    !/checkAndRecordSpend/.test(fs.readFileSync(`${root}/src/app/api/payments/verify-onchain/route.ts`, 'utf8')) &&
    !/checkAndRecordSpend/.test(nanoSettleCode) &&
    !/checkAndRecordSpend/.test(createSrc));

  // ── M18 (batch 5): session-version invalidation ─────────────────────────
  const loginSrc = fs.readFileSync(`${root}/src/app/api/merchant/login/route.ts`, 'utf8');
  const resetSrc = fs.readFileSync(`${root}/src/app/api/merchant/reset-password/route.ts`, 'utf8');
  const middlewareSrc = fs.readFileSync(`${root}/src/lib/middleware/withMerchantAuth.ts`, 'utf8');
  ok('M18: login token carries the session version',
    /sessionVersion: merchant\.sessionVersion \?\? 0/.test(loginSrc));
  ok('M18: reset-password bumps the session version',
    /sessionVersion: \{ increment: 1 \}/.test(resetSrc));
  ok('M18: middleware rejects stale/missing session-version claims',
    /sessionVersionMatches\(payload, merchant\)/.test(middlewareSrc));
  const migrationSql = fs.readFileSync(`${root}/prisma/migrations/0008_merchant_session_version/migration.sql`, 'utf8');
  ok('M18: migration adds sessionVersion with default 0',
    /ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0/.test(migrationSql));
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
  await exploit3();
  await exploit4();
  await exploit5();

  // Cleanup any leftover repro rows.
  for (const ref of cleanupRefs) {
    await prisma.paymentLog.delete({ where: { reference: ref } }).catch(() => { });
  }
  await prisma.scheduledPayment.deleteMany({ where: { description: { contains: 'audit-repro' } } }).catch(() => { });
  await prisma.paymentLog.deleteMany({ where: { description: { contains: 'audit-repro' } } }).catch(() => { });
  await prisma.nanoPayment.deleteMany({ where: { description: { contains: 'audit-repro' } } }).catch(() => { });

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
