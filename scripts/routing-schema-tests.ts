// scripts/routing-schema-tests.ts
//
// Phase 2 focused tests: PaymentLog.payTokenAddress, PaymentConversion 1:1
// child, Merchant.settlementTokenAddress default. Creates throwaway rows with
// a `ROUTINGTEST-` prefix and deletes them afterwards — no fixture residue.
//
// Run:  npx tsx scripts/routing-schema-tests.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const POOL = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '').trim();
const REF = `ROUTINGTEST-${Date.now()}`;

async function main() {
  // 1. legacy row: payTokenAddress NULL stays valid (same-token/legacy)
  const legacy = await prisma.paymentLog.create({
    data: {
      reference: `${REF}-LEGACY`, amount: 1.0, currency: 'USDC', tokenAddress: USDC,
      chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout', merchant: 'routing-test',
      status: 'PENDING',
    },
  });
  ok('legacy row has NULL payTokenAddress', legacy.payTokenAddress === null);
  const legacyRead = await prisma.paymentLog.findUnique({ where: { reference: `${REF}-LEGACY` }, include: { conversion: true } });
  ok('legacy row has no conversion', legacyRead?.conversion === null);

  // 2. routed row: payTokenAddress = X, settlement stays Y
  const routed = await prisma.paymentLog.create({
    data: {
      reference: `${REF}-ROUTED`, amount: 0.65, currency: 'EURC', tokenAddress: EURC,
      payTokenAddress: USDC,
      chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout', merchant: 'routing-test',
      status: 'PENDING',
    },
  });
  ok('routed row stores payTokenAddress X', routed.payTokenAddress === USDC);
  ok('routed row settlement stays Y', routed.currency === 'EURC' && routed.tokenAddress === EURC);

  // 3. conversion child with exact integer strings
  const conv = await (prisma as any).paymentConversion.create({
    data: {
      paymentLogId: routed.id, status: 'QUOTED',
      inputTokenAddress: USDC, inputAmount: '1000000',
      outputTokenAddress: EURC, quotedOutputAmount: '653660', minOutputAmount: '647123',
      quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      quoteHash: `qhash-${REF}`,
      poolAddress: POOL, idempotencyKey: `conv-${REF}`,
    },
  });
  ok('conversion created QUOTED', conv.status === 'QUOTED');
  const withConv = await prisma.paymentLog.findUnique({ where: { id: routed.id }, include: { conversion: true } });
  ok('1:1 conversion readable from PaymentLog', (withConv as any)?.conversion?.id === conv.id);

  // 4. second conversion for same payment refused (1:1 unique)
  let dupRejected = false;
  try {
    await (prisma as any).paymentConversion.create({
      data: {
        paymentLogId: routed.id, status: 'QUOTED',
        inputTokenAddress: USDC, inputAmount: '1000000',
        outputTokenAddress: EURC, quotedOutputAmount: '653660', minOutputAmount: '647123',
        quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        quoteHash: `qhash2-${REF}`,
        poolAddress: POOL, idempotencyKey: `conv2-${REF}`,
      },
    });
  } catch { dupRejected = true; }
  ok('second conversion for same payment rejected', dupRejected);

  // 5. EXECUTED transition persists execution fields
  const exec = await (prisma as any).paymentConversion.update({
    where: { id: conv.id },
    data: { status: 'EXECUTED', executionTxHash: `0x${'ab'.repeat(32)}`, actualInputAmount: '1000000', actualOutputAmount: '653660' },
  });
  ok('EXECUTED persists tx + actuals', exec.executionTxHash?.startsWith('0x') && exec.actualOutputAmount === '653660');

  // 6. merchant settlement preference defaults to NULL (= USDC convention)
  const m = await prisma.merchant.create({
    data: { email: `${REF}@test.local`, businessName: 'Routing Test', passwordHash: 'x' },
  });
  ok('new merchant preference NULL (= USDC default)', m.settlementTokenAddress === null);
  const m2 = await prisma.merchant.update({ where: { id: m.id }, data: { settlementTokenAddress: EURC } });
  ok('merchant preference settable to EURC', m2.settlementTokenAddress === EURC);

  // cleanup (conversion cascades from paymentLog delete; delete explicitly first)
  await (prisma as any).paymentConversion.deleteMany({ where: { paymentLogId: { in: [routed.id] } } });
  await prisma.paymentLog.deleteMany({ where: { reference: { startsWith: REF } } });
  await prisma.merchant.deleteMany({ where: { email: `${REF}@test.local` } });
  const leftovers = await prisma.paymentLog.count({ where: { reference: { startsWith: REF } } });
  ok('test rows cleaned up', leftovers === 0);

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
