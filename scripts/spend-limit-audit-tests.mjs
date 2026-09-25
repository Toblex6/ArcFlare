// scripts/spend-limit-audit-tests.mjs
//
// Regression tests for the 2026-09-19 audit-fix batch:
//
//   C1 - /api/gateway: any ApiKey could drain pooled revenue to any address
//        (no ownership check, "|| SELLER_ADDRESS" fallback, unlisted payout).
//        Closed-proof: an ApiKey that does NOT control the seller gets 403
//        on POST (withdraw) AND on GET (balance leak); no fallback seller.
//
//   H7 - /api/x402/seller/balance/withdraw: signed with SELLER_PRIVATE_KEY,
//        gated by withApiKey only. Closed-proof: an ApiKey that does NOT
//        control the derived seller EOA gets 403.
//
//   Spend-limit gap - payroll/run, scheduled/run, nano, nano/settle,
//        stream/create now enforce the on-chain pre-flight + atomic
//        per-payer window. Closed-proof: stream ceilings reject over-cap
//        values; window atomicity is proven by the companion script
//        scripts/spend-window-atomicity-tests.ts (npx tsx).
//
// Run with the dev server on :3000:
//   node scripts/spend-limit-audit-tests.mjs [baseUrl]

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const prisma = new PrismaClient();

function envLocalValue(name) {
  for (const file of ['.env.local', '.env']) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + name + '=(.*)$', 'm'));
      if (m) return m[1].replace(/["']/g, '');
    } catch { /* missing file */ }
  }
  return undefined;
}
const MERCHANT_JWT_SECRET = envLocalValue('MERCHANT_JWT_SECRET');

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  [PASS] ' + name); }
  else { failed++; console.log('  [FAIL] ' + name + ' ' + detail); }
}
async function j(res) { try { return await res.json(); } catch { return {}; } }
function post(path, body, headers = {}) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body),
  });
}

// Fixture: two merchants. The ATTACKER owns a valid ApiKey + session but
// does NOT control the victim's seller address.
async function makeMerchant(name, wallet) {
  return prisma.merchant.create({
    data: {
      email: name.toLowerCase() + '_' + Date.now() + '@test.local',
      businessName: name,
      passwordHash: 'x',
      apiKey: 'arc_live_audit_' + name.toLowerCase() + '_' + Date.now(),
      verified: true,
      active: true,
      walletAddress: wallet,
    },
  });
}

async function main() {
  const attackerWallet = '0x' + 'fee'.repeat(20);
  const victimWallet = '0x' + 'bed'.repeat(20);
  const attacker = await makeMerchant('AuditAttacker', attackerWallet);
  const victim = await makeMerchant('AuditVictim', victimWallet);
  const attackerKey = attacker.apiKey;

  // Attacker merchant JWT session (merchant_token cookie).
  const attackerCookie = await new SignJWT({ merchantId: attacker.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(MERCHANT_JWT_SECRET));

  try {
    console.log('\n=== C1: /api/gateway ownership gate ===');

    // POST withdraw - key-only attacker naming the VICTIM seller -> 403.
    // withApiKey alone admits the key; the ownership gate must reject it.
    const drainKey = await post('/api/gateway', {
      sellerAddress: victimWallet,
      payoutAddress: attackerWallet,
      amount: '5',
    }, { 'x-api-key': attackerKey });
    const drainKeyBody = await j(drainKey);
    ok('gateway POST: attacker key naming victim seller -> 403 ownership',
      drainKey.status === 403 && /do not control/.test(drainKeyBody.error || ''),
      'got ' + drainKey.status + ': ' + JSON.stringify(drainKeyBody).slice(0, 160));

    // POST withdraw - attacker SESSION naming victim seller -> 403.
    const drainCookie = await post('/api/gateway', {
      sellerAddress: victimWallet,
      payoutAddress: attackerWallet,
      amount: '5',
    }, { cookie: 'merchant_token=' + attackerCookie, 'x-api-key': attackerKey });
    const drainCookieBody = await j(drainCookie);
    ok('gateway POST: attacker session naming victim seller -> 403 ownership',
      drainCookie.status === 403 && /do not control/.test(drainCookieBody.error || ''),
      'got ' + drainCookie.status + ': ' + JSON.stringify(drainCookieBody).slice(0, 160));

    // Fallback removed: no sellerAddress -> 400, never silently SELLER_ADDRESS.
    const noSeller = await post('/api/gateway', {
      payoutAddress: attackerWallet,
      amount: '5',
    }, { cookie: 'merchant_token=' + attackerCookie, 'x-api-key': attackerKey });
    ok('gateway POST: no sellerAddress -> 400 (fallback removed)',
      noSeller.status === 400, 'got ' + noSeller.status);

    // GET balance leak - attacker key querying victim seller -> 403.
    const leak = await fetch(BASE + '/api/gateway?sellerAddress=' + victimWallet, {
      headers: { 'x-api-key': attackerKey },
    });
    ok('gateway GET: attacker key querying victim balance -> 403',
      leak.status === 403, 'got ' + leak.status);

    console.log('\n=== H7: x402 seller withdraw ownership gate ===');

    // Key-only attacker -> 403 from the ownership gate.
    const h7key = await post('/api/x402/seller/balance/withdraw',
      { amount: '1' }, { 'x-api-key': attackerKey });
    const h7keyBody = await j(h7key);
    ok('seller withdraw: attacker key (no seller control) -> 403',
      h7key.status === 403 && /do not control/.test(h7keyBody.error || ''),
      'got ' + h7key.status + ': ' + JSON.stringify(h7keyBody).slice(0, 160));

    // Attacker session -> also 403 (attacker EOA != SELLER_PRIVATE_KEY EOA).
    const h7cookie = await post('/api/x402/seller/balance/withdraw',
      { amount: '1' },
      { cookie: 'merchant_token=' + attackerCookie, 'x-api-key': attackerKey });
    const h7cookieBody = await j(h7cookie);
    ok('seller withdraw: attacker session (no seller control) -> 403',
      h7cookie.status === 403 && /do not control/.test(h7cookieBody.error || ''),
      'got ' + h7cookie.status + ': ' + JSON.stringify(h7cookieBody).slice(0, 160));

    console.log('\n=== Spend-limit: stream/create ceilings ===');

    const bigRate = await post('/api/payments/stream/create', {
      senderSCA: attackerWallet,
      receiverSCA: attackerWallet,
      ratePerSecond: 999999,
      totalDeposited: '100',
      reference: 'audit-rate-abuse',
    }, { 'x-api-key': attackerKey });
    const bigRateBody = await j(bigRate);
    ok('stream/create: ratePerSecond over ceiling -> 400',
      bigRate.status === 400 && /ratePerSecond/.test(bigRateBody.error || ''),
      'got ' + bigRate.status + ': ' + JSON.stringify(bigRateBody).slice(0, 160));

    const bigDeposit = await post('/api/payments/stream/create', {
      senderSCA: attackerWallet,
      receiverSCA: attackerWallet,
      ratePerSecond: 1,
      totalDeposited: 99999999,
      reference: 'audit-deposit-abuse',
    }, { 'x-api-key': attackerKey });
    const bigDepositBody = await j(bigDeposit);
    ok('stream/create: totalDeposited over ceiling -> 400',
      bigDeposit.status === 400 && /totalDeposited/.test(bigDepositBody.error || ''),
      'got ' + bigDeposit.status + ': ' + JSON.stringify(bigDepositBody).slice(0, 160));

    console.log('\nNOTE: window atomicity (serializable + FOR UPDATE proof) runs via:');
    console.log('  npx tsx scripts/spend-window-atomicity-tests.ts');
  } finally {
    await prisma.merchant.deleteMany({ where: { id: { in: [attacker.id, victim.id] } } });
  }

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error('FATAL:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

