// scripts/routing-preference-tests.ts
//
// Phase 5 tests: merchant settlement preference + payment creation flows.
//   - default USDC: no preference → new invoices settle USDC
//   - switch to EURC → future invoices (initialize + payment-link) inherit EURC
//   - existing invoices frozen (never mutated by a preference change)
//   - explicit per-invoice currency always wins over the default
//   - unsupported symbol / arbitrary address / symbol-address mismatch rejected
//
// Run:  npx tsx scripts/routing-preference-tests.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { requireJwtSecret } from '@/src/lib/auth/secrets';
// NOTE: route modules are imported dynamically inside main(), AFTER the
// .env.local override below. Static imports would evaluate the routes'
// module-level JWT-secret capture with .env only (.env and .env.local carry
// different MERCHANT_JWT_SECRET values), breaking merchant_token auth.
import {
  resolveMerchantSettlementPreference,
  resolvePreferenceUpdate,
} from '@/src/lib/routing/preference';

const prisma = new PrismaClient();

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ATTACKER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const WALLET = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';
const REF = `ROUTINGP-${Date.now()}`;

function req(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function main() {
  const { POST: initPOST } = await import('@/app/api/payments/initialize/route');
  const { POST: linkPOST } = await import('@/app/api/merchant/payment-link/route');
  const { PATCH: prefPATCH } = await import('@/app/api/merchant/me/route');
  // unit: preference resolution
  ok('NULL preference → USDC default', resolveMerchantSettlementPreference({ settlementTokenAddress: null }).symbol === 'USDC');
  ok('EURC preference resolves', resolveMerchantSettlementPreference({ settlementTokenAddress: EURC }).address === EURC);
  let threw = false;
  try { resolveMerchantSettlementPreference({ settlementTokenAddress: ATTACKER }); } catch { threw = true; }
  ok('arbitrary stored address throws', threw);
  ok('symbol update → canonical address', resolvePreferenceUpdate({ settlementToken: 'EURC' }) === EURC);
  ok('address update → canonical address', resolvePreferenceUpdate({ settlementTokenAddress: USDC }) === USDC);
  threw = false;
  try { resolvePreferenceUpdate({ settlementToken: 'USDC', settlementTokenAddress: EURC }); } catch { threw = true; }
  ok('symbol/address mismatch rejected', threw);
  threw = false;
  try { resolvePreferenceUpdate({ settlementToken: 'BTC' }); } catch { threw = true; }
  ok('unsupported symbol rejected', threw);
  threw = false;
  try { resolvePreferenceUpdate({}); } catch { threw = true; }
  ok('empty update rejected', threw);

  // fixture merchant (api-key + JWT capable, payout wallet set)
  const apiKey = `pref-key-${Date.now()}`;
  const m = await (prisma as any).merchant.create({
    data: {
      email: `${REF}@test.local`, businessName: `PrefTest ${REF}`,
      passwordHash: 'x', apiKey, walletAddress: WALLET, verified: true, active: true,
    },
  });
  ok('fixture preference NULL (= USDC)', m.settlementTokenAddress === null);
  const jwt = await new SignJWT({ merchantId: m.id })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(requireJwtSecret('MERCHANT_JWT_SECRET'));
  const cookie = { cookie: `merchant_token=${jwt}` };
  const keyHeader = { 'x-api-key': apiKey };

  async function createViaInit(body: unknown) {
    const res: any = await initPOST(req('http://localhost/api/payments/initialize', 'POST', body, keyHeader));
    return { status: res.status, body: await res.json() };
  }

  // 1. default USDC inheritance (no currency named)
  const r1 = await createViaInit({ amount: '1.00' });
  ok('initialize without currency → USDC by default', r1.status === 200 && r1.body?.data?.currency === 'USDC', `${r1.status} ${r1.body?.data?.currency}`);
  const rowA = await prisma.paymentLog.findUnique({ where: { reference: r1.body.reference } });
  ok('invoice A frozen as USDC', rowA?.currency === 'USDC' && (rowA as any)?.tokenAddress === USDC);

  // 2. switch default to EURC
  const p1: any = await prefPATCH(req('http://localhost/api/merchant/me', 'PATCH', { settlementToken: 'EURC' }, cookie));
  const p1b = await p1.json();
  ok('PATCH preference → EURC', p1.status === 200 && p1b?.settlementPreference?.symbol === 'EURC', `${p1.status}`);
  ok('canonical address persisted', (await (prisma as any).merchant.findUnique({ where: { id: m.id } }))?.settlementTokenAddress === EURC);

  // 3. future invoices inherit EURC on both creation paths
  const r2 = await createViaInit({ amount: '2.00' });
  ok('initialize inherits EURC', r2.status === 200 && r2.body?.data?.currency === 'EURC', `${r2.status} ${r2.body?.data?.currency}`);
  const l1: any = await linkPOST(req('http://localhost/api/merchant/payment-link', 'POST', { amount: '3.00' }, cookie));
  const l1b = await l1.json();
  ok('payment-link inherits EURC', l1.status === 200 && l1b?.currency === 'EURC', `${l1.status} ${l1b?.currency}`);

  // 4. existing invoice untouched by the switch
  const rowA2 = await prisma.paymentLog.findUnique({ where: { reference: r1.body.reference } });
  ok('invoice A still USDC after switch', rowA2?.currency === 'USDC' && (rowA2 as any)?.tokenAddress === USDC);

  // 5. explicit per-invoice currency wins over the default
  const r3 = await createViaInit({ amount: '1.00', currency: 'USDC' });
  ok('explicit USDC wins over EURC default', r3.status === 200 && r3.body?.data?.currency === 'USDC');
  const l2: any = await linkPOST(req('http://localhost/api/merchant/payment-link', 'POST', { amount: '1.00', currency: 'USDC' }, cookie));
  ok('payment-link explicit USDC wins', l2.status === 200 && (await l2.json())?.currency === 'USDC');

  // 6. rejections
  const bad1: any = await prefPATCH(req('http://localhost/api/merchant/me', 'PATCH', { settlementToken: 'BTC' }, cookie));
  ok('unsupported symbol rejected', bad1.status === 400, `${bad1.status}`);
  const bad2: any = await prefPATCH(req('http://localhost/api/merchant/me', 'PATCH', { settlementTokenAddress: ATTACKER }, cookie));
  ok('arbitrary address rejected', bad2.status === 400, `${bad2.status}`);
  const bad3: any = await prefPATCH(req('http://localhost/api/merchant/me', 'PATCH', { settlementToken: 'USDC', settlementTokenAddress: EURC }, cookie));
  ok('symbol/address mismatch rejected', bad3.status === 400, `${bad3.status}`);
  ok('preference unchanged after rejections', (await (prisma as any).merchant.findUnique({ where: { id: m.id } }))?.settlementTokenAddress === EURC);
  const badInit = await createViaInit({ amount: '1.00', currency: 'BTC' });
  ok('explicit bad currency still 400', badInit.status === 400, `${badInit.status}`);

  // cleanup
  await (prisma as any).platformFee.deleteMany({ where: { paymentLog: { merchant: `PrefTest ${REF}` } } }).catch(() => null);
  await (prisma as any).paymentConversion.deleteMany({ where: { paymentLog: { merchant: `PrefTest ${REF}` } } }).catch(() => null);
  await prisma.paymentLog.deleteMany({ where: { merchant: `PrefTest ${REF}` } });
  await (prisma as any).merchant.delete({ where: { id: m.id } });
  ok('test rows cleaned up', (await prisma.paymentLog.count({ where: { merchant: `PrefTest ${REF}` } })) === 0);

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main()
  .catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
