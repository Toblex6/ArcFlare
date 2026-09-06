// scripts/routing-verify-tests.ts
//
// Phase 4 tests for routed-settlement verification (verify-onchain routed leg):
//
//   A. pure matrix (synthetic events, no network/funds): payer/tokenIn/
//      tokenOut/pool/recipient binding, exact input binding, minOut boundary,
//      expiry boundary, consumed/resume states, malformed + foreign logs.
//   B. live loop (testnet funds: 3 small routes + gas; throwaway ROUTINGV-
//      rows deleted afterwards):
//        USDC→USDC direct unchanged · EURC→EURC direct unchanged ·
//        USDC→EURC routed SUCCESS · EURC→USDC routed SUCCESS · replay
//        alreadySettled · approve-tx (no router event) rejected · wrong
//        tokenIn rejected · input-amount binding rejected · below-minOut
//        rejected · consumed-by-another rejected · failed attempts consume
//        nothing (payment still verifiable afterwards).
//
// Run:  npx tsx scripts/routing-verify-tests.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { AbiCoder, id, zeroPadValue } from 'ethers';
import { Contract, JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { requestQuote } from '@/src/lib/routing/quoter';
import { POST as verifyPOST } from '@/app/api/payments/verify-onchain/route';
import {
  PAYMENT_ROUTED_ABI,
  checkRoutedExecution,
  findRoutedEvent,
} from '@/src/lib/routing/verifier';

const prisma = new PrismaClient();

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function throwsWith(label: string, fn: () => unknown, status: number) {
  try { fn(); ok(label, false, 'did NOT throw'); }
  catch (e: any) { ok(label, (e as any)?.status === status, `status=${(e as any)?.status} ${(e?.message ?? '').slice(0, 70)}`); }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const POOL = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '').trim();
const ROUTER = (process.env.PAYMENT_ROUTER_CONTRACT_ADDRESS ?? '').trim();
const PAYER = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';
const MERCHANT = PAYER;
const REF = `ROUTINGV-${Date.now()}`;
const NOW = () => Math.floor(Date.now() / 1000);

function baseConv(over: Record<string, any> = {}) {
  return {
    status: 'QUOTED',
    inputTokenAddress: USDC,
    inputAmount: '1000000',
    outputTokenAddress: EURC,
    minOutputAmount: '640000',
    quoteExpiresAt: new Date(Date.now() + 300_000),
    executionTxHash: null,
    ...over,
  };
}
function baseEv(over: Record<string, any> = {}) {
  return {
    payer: PAYER, tokenIn: USDC, amountIn: 1000000n,
    tokenOut: EURC, amountOut: 650000n, recipient: MERCHANT, pool: POOL,
    ...over,
  };
}
function baseParams(over: Record<string, any> = {}) {
  return {
    event: baseEv(),
    conversion: baseConv(),
    settlementAddress: EURC,
    merchantSCA: MERCHANT,
    canonicalPool: POOL,
    canonicalRouter: ROUTER,
    blockTimestampSec: NOW(),
    knownPayer: null,
    ...over,
  };
}

async function pure() {
  console.log('── A. pure verification matrix ────────────────────────────────');
  const r = checkRoutedExecution(baseParams());
  ok('valid execution passes', r.payer === PAYER && r.actualInput === '1000000' && r.actualOutput === '650000');
  ok('known payer match passes', checkRoutedExecution(baseParams({ knownPayer: PAYER })).payer === PAYER);
  throwsWith('known payer mismatch 403', () => checkRoutedExecution(baseParams({ knownPayer: '0x2222222222222222222222222222222222222222' })), 403);
  throwsWith('zero payer', () => checkRoutedExecution(baseParams({ event: baseEv({ payer: '0x0000000000000000000000000000000000000000' }) })), 400);
  throwsWith('router as payer', () => checkRoutedExecution(baseParams({ event: baseEv({ payer: ROUTER }) })), 400);
  throwsWith('pool as payer', () => checkRoutedExecution(baseParams({ event: baseEv({ payer: POOL }) })), 400);
  throwsWith('token as payer', () => checkRoutedExecution(baseParams({ event: baseEv({ payer: USDC }) })), 400);
  throwsWith('wrong tokenIn', () => checkRoutedExecution(baseParams({ event: baseEv({ tokenIn: EURC }) })), 400);
  throwsWith('wrong tokenOut', () => checkRoutedExecution(baseParams({ event: baseEv({ tokenOut: USDC }) })), 400);
  throwsWith('wrong pool', () => checkRoutedExecution(baseParams({ event: baseEv({ pool: '0x3333333333333333333333333333333333333333' }) })), 400);
  throwsWith('wrong recipient', () => checkRoutedExecution(baseParams({ event: baseEv({ recipient: '0x4444444444444444444444444444444444444444' }) })), 400);
  throwsWith('input over by 1', () => checkRoutedExecution(baseParams({ event: baseEv({ amountIn: 1000001n }) })), 400);
  throwsWith('input under by 1', () => checkRoutedExecution(baseParams({ event: baseEv({ amountIn: 999999n }) })), 400);
  ok('output exactly at minOut passes', checkRoutedExecution(baseParams({ event: baseEv({ amountOut: 640000n }) })).actualOutput === '640000');
  throwsWith('output below minOut', () => checkRoutedExecution(baseParams({ event: baseEv({ amountOut: 639999n }) })), 400);
  const exp = NOW() + 300;
  ok('execution at expiry second passes', !!checkRoutedExecution(baseParams({ conversion: baseConv({ quoteExpiresAt: new Date(exp * 1000) }), blockTimestampSec: exp })));
  throwsWith('execution past expiry', () => checkRoutedExecution(baseParams({ conversion: baseConv({ quoteExpiresAt: new Date(exp * 1000) }), blockTimestampSec: exp + 1 })), 400);
  throwsWith('consumed quote 409', () => checkRoutedExecution(baseParams({ conversion: baseConv({ status: 'EXECUTED' }) })), 409);
  ok('same-tx resume passes checks', !!checkRoutedExecution(baseParams({ conversion: baseConv({ status: 'EXECUTED' }), allowExecutedResume: true })));
  throwsWith('expired quote state', () => checkRoutedExecution(baseParams({ conversion: baseConv({ status: 'EXPIRED' }) })), 400);

  // findRoutedEvent over real-encoded logs (ethers ABI coder → standard encoding)
  const coder = new AbiCoder();
  const routedSig = id('PaymentRouted(address,address,uint256,address,uint256,address,address)');
  const topics = [routedSig, zeroPadValue(PAYER, 32), zeroPadValue(USDC, 32), zeroPadValue(EURC, 32)];
  const data = coder.encode(['uint256', 'uint256', 'address', 'address'], [1000000n, 650000n, MERCHANT, POOL]);
  const found = findRoutedEvent([{ address: ROUTER, topics, data }], ROUTER);
  ok('real-encoded PaymentRouted decodes', !!found && found.amountIn === 1000000n && found.pool === POOL);
  ok('foreign router log ignored', findRoutedEvent([{ address: '0x5555555555555555555555555555555555555555', topics, data }], ROUTER) === null);
  const tSig = id('Transfer(address,address,uint256)');
  const tTopics = [tSig, zeroPadValue(PAYER, 32), zeroPadValue(MERCHANT, 32)];
  const tData = coder.encode(['uint256'], [1n]);
  ok('plain Transfer log never matches', findRoutedEvent([{ address: USDC, topics: tTopics, data: tData }], ROUTER) === null);
  ok('empty logs → null', findRoutedEvent([], ROUTER) === null);
}

async function verifyCall(reference: string, txHash: string, retries = 3): Promise<{ status: number; body: any }> {
  let last: any = null;
  for (let i = 0; i < retries; i++) {
    const res: any = await verifyPOST(new NextRequest('http://localhost/api/payments/verify-onchain', {
      method: 'POST', body: JSON.stringify({ reference, txHash }),
    }));
    const body = await res.json().catch(() => ({}));
    if (res.status !== 500 || !/rpc|fetch|network|timeout/i.test(JSON.stringify(body))) return { status: res.status, body };
    last = { status: res.status, body };
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return last;
}

async function live() {
  console.log('── B. live testnet loop ───────────────────────────────────────');
  const rpc = new JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const pk = (process.env.RELAYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? '').trim();
  const signer = new Wallet(pk, rpc);
  const me = await signer.getAddress();
  const erc20 = (a: string) => new Contract(a, ['function approve(address,uint256) returns (bool)'], signer);
  const router = new Contract(ROUTER, ['function route(address,uint256,uint256,uint256,address) returns (uint256)'], signer);

  async function mkInvoice(ref: string, amount: number, currency: string) {
    return prisma.paymentLog.create({
      data: {
        reference: ref, amount, currency,
        tokenAddress: currency === 'EURC' ? EURC : USDC,
        chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout',
        merchant: 'routing-verify-test', merchantSCA: me, status: 'PENDING',
      },
    });
  }
  async function executeQuote(q: any): Promise<{ txHash: string; approveHash: string }> {
    const t = erc20(q.payToken.address);
    const atx = await t.approve(ROUTER, BigInt(q.inputAmount));
    await atx.wait();
    const rtx = await router.route(q.payToken.address, BigInt(q.inputAmount), BigInt(q.minOutputAmount), q.deadline, q.recipient);
    const rec = await rtx.wait();
    return { txHash: rec.hash as string, approveHash: atx.hash as string };
  }

  const p1 = await mkInvoice(`${REF}-P1`, 0.1, 'EURC');
  const p2 = await mkInvoice(`${REF}-P2`, 0.15, 'USDC');
  const p3 = await mkInvoice(`${REF}-P3`, 0.1, 'EURC');
  const p4 = await mkInvoice(`${REF}-P4`, 0.2, 'USDC');   // quoted EURC-pay (wrong-token target)
  const p5 = await mkInvoice(`${REF}-P5`, 0.1, 'EURC');   // doctored input (binding target)
  const pBig = await mkInvoice(`${REF}-PBIG`, 1.0, 'EURC'); // doctored minOut target
  const pDirU = await mkInvoice(`${REF}-DU`, 0.05, 'USDC'); // direct-path controls
  const pDirE = await mkInvoice(`${REF}-DE`, 0.05, 'EURC');

  const q1 = await requestQuote({ reference: p1.reference, payToken: 'USDC' });
  const q2 = await requestQuote({ reference: p2.reference, payToken: 'EURC' });
  const q3 = await requestQuote({ reference: p3.reference, payToken: 'USDC' });
  await requestQuote({ reference: p4.reference, payToken: 'EURC' });
  const q5 = await requestQuote({ reference: p5.reference, payToken: 'USDC' });
  await requestQuote({ reference: pBig.reference, payToken: 'USDC' });

  const ex1 = await executeQuote(q1);
  console.log(`  routed TX1 USDC->EURC ${ex1.txHash}`);
  const ex2 = await executeQuote(q2);
  console.log(`  routed TX2 EURC->USDC ${ex2.txHash}`);
  const ex3 = await executeQuote(q3);
  console.log(`  routed TX3 USDC->EURC ${ex3.txHash}`);

  // direct-path controls: plain transfers still verify the old way
  const usdc = new Contract(USDC, ['function transfer(address,uint256) returns (bool)'], signer);
  const eurc = new Contract(EURC, ['function transfer(address,uint256) returns (bool)'], signer);
  const dtxU = await (await usdc.transfer(me, parseUnits('0.05', 6))).wait();
  const vDU = await verifyCall(pDirU.reference, dtxU.hash);
  ok('USDC→USDC direct unchanged', vDU.body?.success === true, JSON.stringify(vDU.body).slice(0, 100));
  const dtxE = await (await eurc.transfer(me, parseUnits('0.05', 6))).wait();
  const vDE = await verifyCall(pDirE.reference, dtxE.hash);
  ok('EURC→EURC direct unchanged', vDE.body?.success === true, JSON.stringify(vDE.body).slice(0, 100));

  // routed successes
  const v1 = await verifyCall(p1.reference, ex1.txHash);
  ok('USDC→EURC routed SUCCESS', v1.body?.success === true, JSON.stringify(v1.body).slice(0, 120));
  const c1 = await (prisma as any).paymentConversion.findUnique({ where: { paymentLogId: p1.id } });
  ok('conversion EXECUTED with actuals', c1?.status === 'EXECUTED' && c1?.executionTxHash === ex1.txHash && !!c1?.actualInputAmount && !!c1?.actualOutputAmount,
    `${c1?.status} in=${c1?.actualInputAmount} out=${c1?.actualOutputAmount}`);
  ok('payment carries arcTxHash + payer', (await prisma.paymentLog.findUnique({ where: { id: p1.id } }))?.arcTxHash === ex1.txHash);
  const v1r = await verifyCall(p1.reference, ex1.txHash);
  ok('replay → alreadySettled', v1r.body?.success === true && v1r.body?.alreadySettled === true);

  const v2 = await verifyCall(p2.reference, ex2.txHash);
  ok('EURC→USDC routed SUCCESS', v2.body?.success === true, JSON.stringify(v2.body).slice(0, 120));

  // negatives (TX3 still unconsumed throughout a–e)
  const vA = await verifyCall(p3.reference, ex1.approveHash);
  ok('approve tx (no router event) rejected', vA.body?.success === false && vA.status === 400, JSON.stringify(vA.body).slice(0, 100));

  const vC = await verifyCall(p4.reference, ex3.txHash);
  ok('wrong tokenIn rejected', vC.body?.success === false && vC.status === 400, JSON.stringify(vC.body).slice(0, 100));

  await (prisma as any).paymentConversion.update({
    where: { paymentLogId: p5.id },
    data: { inputAmount: (BigInt(q5.inputAmount!) + 1n).toString() },
  });
  const vD = await verifyCall(p5.reference, ex3.txHash);
  ok('input-amount binding rejected', vD.body?.success === false && vD.status === 400, JSON.stringify(vD.body).slice(0, 100));

  await (prisma as any).paymentConversion.update({
    where: { paymentLogId: pBig.id },
    data: { inputAmount: q3.inputAmount, minOutputAmount: '999999999999' },
  });
  const vE = await verifyCall(pBig.reference, ex3.txHash);
  ok('below-minOut rejected', vE.body?.success === false && vE.status === 400, JSON.stringify(vE.body).slice(0, 100));

  const vF = await verifyCall(p3.reference, ex1.txHash);
  ok('consumed-by-another rejected', vF.body?.success === false && vF.status === 409, JSON.stringify(vF.body).slice(0, 100));

  // failed attempts consumed nothing: P3 still verifies with its own tx
  const v3 = await verifyCall(p3.reference, ex3.txHash);
  ok('payment verifiable after failed attempts', v3.body?.success === true, JSON.stringify(v3.body).slice(0, 120));
  const c3 = await (prisma as any).paymentConversion.findUnique({ where: { paymentLogId: p3.id } });
  ok('P3 conversion EXECUTED once', c3?.status === 'EXECUTED' && c3?.executionTxHash === ex3.txHash);

  // cleanup (fee DEFERRED rows first, then conversions, then payments)
  const ids = [p1.id, p2.id, p3.id, p4.id, p5.id, pBig.id, pDirU.id, pDirE.id];
  await (prisma as any).platformFee.deleteMany({ where: { paymentLogId: { in: ids } } });
  await (prisma as any).paymentConversion.deleteMany({ where: { paymentLogId: { in: ids } } });
  await prisma.paymentLog.deleteMany({ where: { reference: { startsWith: REF } } });
  ok('test rows cleaned up', (await prisma.paymentLog.count({ where: { reference: { startsWith: REF } } })) === 0);
}

async function main() {
  await pure();
  await live();
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main()
  .catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
