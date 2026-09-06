// scripts/routing-quote-tests.ts
//
// Phase 3 tests for POST /api/payments/quote (via the quoter + handler):
//   unit (exact integer math, no network):
//     pool formula spot value, monotonicity, discount floor, input search
//     covering the invoice, zero/negative/empty-pool guards, depth + size
//     caps, deterministic quote hash + tamper-evidence.
//   integration (live testnet RPC reads + dev DB, no funds move — quoting is
//   read-only; throwaway ROUTINGQ- rows are deleted afterwards):
//     USDC→EURC quote, EURC→USDC quote, same-token no-quote, unsupported
//     token, malformed reference, expired quote rotation, too-large trade,
//     quote replay (single live row), already-settled 409, client
//     output/minOut/pool tampering ignored (handler-level).
//
// Run:  npx tsx scripts/routing-quote-tests.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { parseBody, QuoteSchema } from '@/lib/validation';
import {
  computeQuoteHash,
  deriveQuoteInput,
  discountForSlippage,
  poolQuoteOut,
} from '@/src/lib/routing/quoteMath';
import { requestQuote } from '@/src/lib/routing/quoter';
import { POST } from '@/app/api/payments/quote/route';

const prisma = new PrismaClient();

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failed(); failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
  function failed() { fail++; }
}
async function expectQuoteErr(label: string, fn: () => Promise<unknown>, status: number, needle?: string) {
  try {
    await fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    const st = (e as any)?.status;
    ok(label, st === status && (!needle || String(e.message).includes(needle)), `status=${st} msg=${String(e.message).slice(0, 80)}`);
  }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const POOL = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '').trim();
const MERCHANT = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';
const REF = `ROUTINGQ-${Date.now()}`;

async function unit() {
  console.log('── unit: exact math ───────────────────────────────────────────');
  ok('pool formula spot value', poolQuoteOut(1_000000n, 20_000000n, 20_000000n) === 949659n, poolQuoteOut(1_000000n, 20_000000n, 20_000000n).toString());
  ok('quote monotonic in input', poolQuoteOut(2_000000n, 20_000000n, 20_000000n) > poolQuoteOut(1_000000n, 20_000000n, 20_000000n));
  ok('quote below input (fee + price impact)', poolQuoteOut(1_000000n, 20_000000n, 20_000000n) < 1_000000n);
  let threw = false;
  try { poolQuoteOut(0n, 20_000000n, 20_000000n); } catch { threw = true; }
  ok('zero input throws', threw);
  threw = false;
  try { poolQuoteOut(1_000000n, 0n, 20_000000n); } catch { threw = true; }
  ok('empty pool throws', threw);

  const d = deriveQuoteInput({ invoiceAmountY: 650000n, reserveIn: 26_000000n, reserveOut: 18_000000n, slippageBps: 100, outFeeBuffer: 1000n });
  ok('derived minOut covers invoice', d.minOutput >= 650000n, d.minOutput.toString());
  ok('derived input sane (< 2x naive)', d.inputAmount < 2n * (650000n * 26_000000n) / 18_000000n, d.inputAmount.toString());
  ok('derived quoted positive', d.quotedOutput > d.minOutput, `${d.quotedOutput} / ${d.minOutput}`);
  ok('discount strips slippage + buffer', discountForSlippage(1_000000n, 100, 5000n) === 1_000000n - 10000n - 5000n);
  threw = false;
  try { deriveQuoteInput({ invoiceAmountY: 0n, reserveIn: 1n, reserveOut: 1n, slippageBps: 100, outFeeBuffer: 0n }); } catch { threw = true; }
  ok('zero invoice throws', threw);
  threw = false;
  try { deriveQuoteInput({ invoiceAmountY: 5_000000n, reserveIn: 26_000000n, reserveOut: 4_000000n, slippageBps: 100, outFeeBuffer: 1000n }); } catch { threw = true; }
  ok('invoice beyond reserves throws', threw);
  threw = false;
  try { deriveQuoteInput({ invoiceAmountY: 5_000_000000n, reserveIn: 26_000_000000n, reserveOut: 26_000_000000n, slippageBps: 100, outFeeBuffer: 1000n }); } catch { threw = true; }
  ok('trade above absolute size cap throws', threw);
  threw = false;
  try { deriveQuoteInput({ invoiceAmountY: 2_000000n, reserveIn: 26_000000n, reserveOut: 10_000000n, slippageBps: 100, outFeeBuffer: 1000n }); } catch { threw = true; }
  ok('trade above 10% depth cap throws', threw);

  const h1 = computeQuoteHash({ reference: 'r', inputToken: USDC, inputAmount: 1n, outputToken: EURC, quotedOutput: 2n, minOutput: 3n, expiresAtSec: 4, poolAddress: POOL, routerAddress: MERCHANT });
  const h2 = computeQuoteHash({ reference: 'r', inputToken: USDC, inputAmount: 1n, outputToken: EURC, quotedOutput: 2n, minOutput: 3n, expiresAtSec: 4, poolAddress: POOL, routerAddress: MERCHANT });
  const h3 = computeQuoteHash({ reference: 'r', inputToken: USDC, inputAmount: 1n, outputToken: EURC, quotedOutput: 2n, minOutput: 999n, expiresAtSec: 4, poolAddress: POOL, routerAddress: MERCHANT });
  ok('quote hash deterministic', h1 === h2, h1);
  ok('quote hash tamper-evident on minOut', h1 !== h3);

  // zod strips attacker-supplied pricing/venue keys before the quoter runs
  const parsed = parseBody(QuoteSchema, {
    reference: 'r', payToken: 'USDC',
    exchangeRate: '100', outputAmount: '1', minOut: '999999',
    poolAddress: '0x0000000000000000000000000000000000000001',
    tokenAddress: '0x0000000000000000000000000000000000000001',
  });
  ok('attacker keys stripped by schema', !!parsed.data && Object.keys(parsed.data as object).join(',') === 'reference,payToken');
}

async function mkInvoice(ref: string, amount: number, currency: string) {
  return prisma.paymentLog.create({
    data: {
      reference: ref, amount, currency,
      tokenAddress: currency === 'EURC' ? EURC : USDC,
      chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout',
      merchant: 'routing-quote-test', merchantSCA: MERCHANT, status: 'PENDING',
    },
  });
}

async function integration() {
  console.log('── integration: quoter (live RPC + dev DB) ────────────────────');
  const eurInvoice = await mkInvoice(`${REF}-EURC`, 0.65, 'EURC');
  const usdcInvoice = await mkInvoice(`${REF}-USDC`, 1.0, 'USDC');

  const q1 = await requestQuote({ reference: eurInvoice.reference, payToken: 'USDC' });
  ok('USDC→EURC quoted', q1.converted && !!q1.quoteHash, q1.inputAmount);
  ok('quote binds canonical pool', q1.pool === POOL);
  ok('quote recipient is frozen merchantSCA', q1.recipient === MERCHANT);
  ok('input/output are integer strings', !!q1.inputAmount && /^\d+$/.test(q1.inputAmount!) && /^\d+$/.test(q1.minOutputAmount!));
  ok('minOut covers invoice (650000)', BigInt(q1.minOutputAmount!) >= 650000n, q1.minOutputAmount);
  ok('expiry ~5min out', Date.parse(q1.quoteExpiresAt!) - Date.now() > 4 * 60 * 1000);
  ok('deadline matches expiry', q1.deadline === Math.floor(Date.parse(q1.quoteExpiresAt!) / 1000));
  const stored = await (prisma as any).paymentConversion.findUnique({ where: { paymentLogId: eurInvoice.id } });
  ok('conversion persisted QUOTED', stored?.status === 'QUOTED' && stored?.inputTokenAddress === USDC);
  ok('payTokenAddress marked on payment', (await prisma.paymentLog.findUnique({ where: { id: eurInvoice.id } }))?.payTokenAddress === USDC);

  // replay: same live quote, no duplicate row
  const q1b = await requestQuote({ reference: eurInvoice.reference, payToken: 'usdc' });
  ok('quote replay returns identical hash', q1b.quoteHash === q1.quoteHash);
  ok('replay creates no second row', (await (prisma as any).paymentConversion.count({ where: { paymentLogId: eurInvoice.id } })) === 1);

  const q2 = await requestQuote({ reference: usdcInvoice.reference, payToken: 'EURC' });
  ok('EURC→USDC quoted', q2.converted && BigInt(q2.minOutputAmount!) >= 1_000000n, q2.minOutputAmount);

  // same-token: no conversion
  const q3 = await requestQuote({ reference: usdcInvoice.reference, payToken: 'USDC' });
  ok('same-token returns direct (no quote)', !q3.converted && q3.message !== undefined);

  await expectQuoteErr('unsupported pay token', () => requestQuote({ reference: usdcInvoice.reference, payToken: 'BTC' }), 400, 'Unsupported pay token');
  await expectQuoteErr('malformed reference', () => requestQuote({ reference: 'NOPE-DOES-NOT-EXIST', payToken: 'USDC' }), 404);

  // too-large trade: invoice far above the size cap
  const big = await mkInvoice(`${REF}-BIG`, 1000000, 'EURC');
  await expectQuoteErr('too-large trade rejected', () => requestQuote({ reference: big.reference, payToken: 'USDC' }), 400);

  // expired quote rotates: live row replaced, old one EXPIRED-history
  await (prisma as any).paymentConversion.update({
    where: { paymentLogId: eurInvoice.id },
    data: { status: 'EXPIRED', quoteExpiresAt: new Date(Date.now() - 1000) },
  });
  const q4 = await requestQuote({ reference: eurInvoice.reference, payToken: 'USDC' });
  ok('expired quote rotates to a fresh hash', q4.converted && q4.quoteHash !== q1.quoteHash);
  ok('one live conversion per payment', (await (prisma as any).paymentConversion.count({ where: { paymentLogId: eurInvoice.id } })) === 1);

  // already-settled invoice refuses quotes
  await prisma.paymentLog.update({ where: { id: usdcInvoice.id }, data: { status: 'SUCCESS' } });
  await expectQuoteErr('settled invoice 409', () => requestQuote({ reference: usdcInvoice.reference, payToken: 'EURC' }), 409);

  // handler-level: attacker pricing/venue fields ignored end-to-end
  const tamperReq = new NextRequest('http://localhost/api/payments/quote', {
    method: 'POST',
    body: JSON.stringify({
      reference: eurInvoice.reference, payToken: 'USDC',
      exchangeRate: '1000000', outputAmount: '999999999', minOutputAmount: '999999999',
      poolAddress: '0x0000000000000000000000000000000000000001',
      router: '0x0000000000000000000000000000000000000002',
      tokenAddress: '0x0000000000000000000000000000000000000003',
    }),
  });
  const tamperRes = await POST(tamperReq);
  const tamperBody = await tamperRes.json();
  ok('handler ignores client minOut (server floor)', tamperBody.converted && tamperBody.minOutputAmount !== '999999999', String(tamperBody.minOutputAmount));
  ok('handler ignores client pool', tamperBody.pool === POOL, String(tamperBody.pool));
  ok('handler ignores client token override', tamperBody.payToken?.address === USDC, String(tamperBody.payToken?.address));

  // cleanup
  await (prisma as any).paymentConversion.deleteMany({ where: { paymentLog: { reference: { startsWith: REF } } } });
  await prisma.paymentLog.deleteMany({ where: { reference: { startsWith: REF } } });
  ok('test rows cleaned up', (await prisma.paymentLog.count({ where: { reference: { startsWith: REF } } })) === 0);
}

async function main() {
  await unit();
  await integration();
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main()
  .catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
