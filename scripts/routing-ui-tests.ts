// scripts/routing-ui-tests.ts
//
// Payment Routing Phase 6 — UI/presentation tests (no funds move):
//   unit (pure, no network/DB):
//     routingCopy: countdown format, payment-language guard, friendly
//     quote-error mapping (headlines carry no DEX vocabulary).
//     quoteView: EURC→USDC + USDC→EURC view-models from fabricated server
//     quotes, direct-quote rejection, same-token rejection.
//     receiptView: settlement/pay-token resolution + conversion displays.
//   render (react-dom/server, no wagmi — components are purely
//   presentational):
//     PayTokenSelector: USDC/EURC only, no 0x literals, 48px touch targets.
//     QuotePanel: loading / ready ("You pay X → Merchant receives Y",
//     rate, minimum received, fee disclosure, live expiry, refresh) /
//     refreshing (auto re-quote) / expired / error (friendly headline +
//     retry + collapsed technical detail).
//     RoutedReceipt: routed X→Y split + direct X==Y rows.
//     mobile safety: wrapping layouts, full-width panels, touch targets,
//     unclipped addresses/amounts, no fixed-pixel page widths.
//   static (content proofs on the wired surfaces):
//     CheckoutWidget: selector + quote fetch + expiry + re-quote +
//     token-aware balance + approve→route execution from the server quote.
//     settings: settlement-currency card; dashboard: preference default +
//     history "Paid with"; checkout/invoice/embed: X vs Y receipt split;
//     verify/all/me routes expose the authoritative read-model.
//   handler (dev DB, throwaway ROUTINGUI- rows, cleaned up):
//     GET /api/merchant/me returns the settlement preference (USDC default,
//     EURC after PATCH); GET /api/payments/verify/[reference] returns the
//     pay token + conversion for a routed row and X==Y/null for a direct row.
//
// Run:  npx tsx scripts/routing-ui-tests.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { requireJwtSecret } from '@/src/lib/auth/secrets';
import {
  FORBIDDEN_CUSTOMER_WORDS,
  formatCountdown,
  friendlyQuoteError,
  usesPaymentLanguage,
} from '@/src/components/checkout/routing/routingCopy';
import { toQuoteViewModel } from '@/src/components/checkout/routing/quoteView';
import { PayTokenSelector } from '@/src/components/checkout/routing/PayTokenSelector';
import { QuotePanel } from '@/src/components/checkout/routing/QuotePanel';
import { RoutedReceipt } from '@/src/components/checkout/routing/RoutedReceipt';
import {
  conversionView,
  payTokenView,
  settlementTokenView,
} from '@/src/lib/routing/receiptView';

const prisma = new PrismaClient();

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ROUTER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const MERCHANT = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';
const REF = `ROUTINGUI-${Date.now()}`;
const futureIso = new Date(Date.now() + 4 * 60_000).toISOString();

// Fabricated server quotes (shape of POST /api/payments/quote, converted).
function eurcToUsdcQuote() {
  return {
    success: true, converted: true, reference: `${REF}-E2U`,
    payToken: { symbol: 'EURC', address: EURC, decimals: 6 },
    settlementToken: { symbol: 'USDC', address: USDC, decimals: 6 },
    inputAmount: '25000000', inputAmountDisplay: '25',
    quotedOutputAmount: '27010000', minOutputAmount: '26730000',
    quoteExpiresAt: futureIso, deadline: Math.floor(Date.now() / 1000) + 240,
    quoteHash: '0xabc', pool: POOL, router: ROUTER, recipient: MERCHANT,
    slippageBps: 100, idempotencyKey: 'q1',
  };
}
function usdcToEurcQuote() {
  return {
    success: true, converted: true, reference: `${REF}-U2E`,
    payToken: { symbol: 'USDC', address: USDC, decimals: 6 },
    settlementToken: { symbol: 'EURC', address: EURC, decimals: 6 },
    inputAmount: '10000000', inputAmountDisplay: '10',
    quotedOutputAmount: '9275000', minOutputAmount: '9181000',
    quoteExpiresAt: futureIso, deadline: Math.floor(Date.now() / 1000) + 240,
    quoteHash: '0xdef', pool: POOL, router: ROUTER, recipient: MERCHANT,
    slippageBps: 100, idempotencyKey: 'q2',
  };
}

async function unit() {
  console.log('── unit: copy + view-models ────────────────────────────────');
  ok('countdown 00:00', formatCountdown(0) === '00:00');
  ok('countdown pads seconds', formatCountdown(65) === '01:05');
  ok('countdown 5-minute quote', formatCountdown(300) === '05:00');
  ok('countdown clamps negative', formatCountdown(-5) === '00:00');
  ok('payment language accepted', usesPaymentLanguage('You pay 25 EURC — Merchant receives 27.01 USDC'));
  for (const w of FORBIDDEN_CUSTOMER_WORDS) {
    ok(`"${w}" rejected from customer copy`, !usesPaymentLanguage(`Your ${w} is ready`));
  }
  const moved = friendlyQuoteError('Pool quote moved against this trade — re-quote and try again.');
  ok('moved-quote maps to friendly headline', moved.headline.includes('fresh quote') && usesPaymentLanguage(moved.headline), moved.headline);
  ok('raw kept for technical details', moved.raw !== null && moved.raw.includes('Pool quote'));
  const settled = friendlyQuoteError('Payment is already settled — no quote needed.');
  ok('settled maps to settled headline', settled.headline.includes('already settled'));
  const generic = friendlyQuoteError(undefined);
  ok('missing error maps to generic retry', generic.headline.includes('try again'));

  const e2u = toQuoteViewModel(eurcToUsdcQuote() as any);
  ok('EURC→USDC pay amount', e2u.payAmountDisplay === '25' && e2u.paySymbol === 'EURC', e2u.payAmountDisplay);
  ok('EURC→USDC merchant receives', e2u.quotedOutputDisplay === '27.01' && e2u.settlementSymbol === 'USDC', e2u.quotedOutputDisplay);
  ok('EURC→USDC minimum received', e2u.minOutputDisplay === '26.73', e2u.minOutputDisplay);
  ok('EURC→USDC rate line', e2u.rateDisplay.includes('1 EURC') && e2u.rateDisplay.includes('USDC'), e2u.rateDisplay);
  ok('EURC→USDC expiry parsed', e2u.expiresAtMs > Date.now());
  const u2e = toQuoteViewModel(usdcToEurcQuote() as any);
  ok('USDC→EURC pay amount', u2e.payAmountDisplay === '10' && u2e.paySymbol === 'USDC');
  ok('USDC→EURC merchant receives', u2e.quotedOutputDisplay === '9.275' && u2e.settlementSymbol === 'EURC', u2e.quotedOutputDisplay);
  let threw = false;
  try { toQuoteViewModel({ success: true, converted: false } as any); } catch { threw = true; }
  ok('direct quote rejected by view-model', threw);
  threw = false;
  try {
    toQuoteViewModel({ ...eurcToUsdcQuote(), settlementToken: { symbol: 'EURC', address: EURC, decimals: 6 } } as any);
  } catch { threw = true; }
  ok('same-token quote rejected by view-model', threw);

  ok('legacy row settles as USDC', settlementTokenView({ currency: null, tokenAddress: null }).symbol === 'USDC');
  ok('NULL pay token reads as settlement (direct)', payTokenView({ payTokenAddress: null, currency: 'EURC', tokenAddress: EURC })?.symbol === 'EURC');
  ok('routed pay token resolves canonically', payTokenView({ payTokenAddress: USDC, currency: 'EURC', tokenAddress: EURC })?.address === USDC);
  ok('non-canonical pay token degrades to null', payTokenView({ payTokenAddress: '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF', currency: 'EURC', tokenAddress: EURC }) === null);
  ok('null conversion row → null view', conversionView(null) === null);
  const cv = conversionView({
    status: 'QUOTED', inputTokenAddress: EURC, inputAmount: '25000000',
    outputTokenAddress: USDC, quotedOutputAmount: '27010000', minOutputAmount: '26730000',
    quoteExpiresAt: new Date(futureIso), executionTxHash: null,
    actualInputAmount: null, actualOutputAmount: null,
  });
  ok('conversion displays derive from canonical decimals', cv?.inputAmountDisplay === '25' && cv?.quotedOutputDisplay === '27.01' && cv?.minOutputDisplay === '26.73');
}

async function renders() {
  console.log('── render: presentational routing UI ───────────────────────');
  const selector = renderToStaticMarkup(
    React.createElement(PayTokenSelector, { settlementSymbol: 'USDC', selected: 'USDC', onSelect: () => null })
  );
  ok('selector offers Pay with USDC/EURC', selector.includes('Pay with') && selector.includes('USDC') && selector.includes('EURC'));
  ok('selector marks the direct token', selector.includes('No conversion'));
  ok('selector marks the converting token', selector.includes('Converts to USDC'));
  ok('selector exposes no addresses', !selector.includes('0x'));
  ok('selector buttons are 48px touch targets', selector.includes('min-height:48'));

  const loading = renderToStaticMarkup(React.createElement(QuotePanel, { state: { status: 'loading' }, onRefresh: () => null }));
  ok('quote loading state renders', loading.includes('Getting your conversion rate'));

  const ready = renderToStaticMarkup(
    React.createElement(QuotePanel, {
      state: { status: 'ready', quote: toQuoteViewModel(eurcToUsdcQuote() as any), secondsLeft: 185 },
      onRefresh: () => null,
    })
  );
  ok('ready shows "You pay X"', ready.includes('You pay 25 EURC'), ready.slice(0, 200));
  ok('ready shows "Merchant receives Y"', ready.includes('Merchant receives') && ready.includes('27.01 USDC'));
  ok('ready shows rate', ready.includes('Rate') && ready.includes('1 EURC'));
  ok('ready shows minimum received', ready.includes('Minimum received') && ready.includes('26.73 USDC'));
  ok('ready discloses the conversion fee', ready.includes('conversion fee'));
  ok('ready shows live expiry', ready.includes('Quote expires in') && ready.includes('03:05'), ready.slice(0, 400));
  ok('ready offers refresh', ready.includes('Refresh quote'));
  ok('ready copy uses payment language only', usesPaymentLanguage(ready.replace(/<[^>]*>/g, ' ')));

  const refreshing = renderToStaticMarkup(React.createElement(QuotePanel, { state: { status: 'refreshing' }, onRefresh: () => null }));
  ok('refreshing covers auto re-quote', refreshing.includes('getting a fresh one') && refreshing.includes('Nothing has been charged'));
  const expired = renderToStaticMarkup(React.createElement(QuotePanel, { state: { status: 'expired' }, onRefresh: () => null }));
  ok('expired offers manual re-quote', expired.includes('Quote expired') && expired.includes('Get a fresh quote'));
  const err = renderToStaticMarkup(
    React.createElement(QuotePanel, { state: { status: 'error', headline: 'The conversion rate just moved. Get a fresh quote to continue.', raw: 'Pool quote moved' }, onRefresh: () => null })
  );
  ok('error shows friendly headline + retry', err.includes('fresh quote') && err.includes('Try again'));
  ok('error collapses technical detail', err.includes('Show technical details') && !err.includes('Pool quote moved'));

  const routed = renderToStaticMarkup(
    React.createElement(RoutedReceipt, {
      converted: true, paySymbol: 'EURC', payAmountDisplay: '25',
      settlementSymbol: 'USDC', settlementAmountDisplay: '27.01',
    })
  );
  ok('receipt splits Paid with / Merchant received', routed.includes('Paid with') && routed.includes('25 EURC') && routed.includes('Merchant received') && routed.includes('27.01 USDC'));
  const direct = renderToStaticMarkup(
    React.createElement(RoutedReceipt, {
      converted: false, paySymbol: 'USDC', payAmountDisplay: '10',
      settlementSymbol: 'USDC', settlementAmountDisplay: '10',
    })
  );
  ok('direct receipt names one token twice (no ambiguity)', direct.includes('Paid directly') && direct.includes('10 USDC'));

  console.log('── render: mobile safety ───────────────────────────────────');
  const all = selector + ready + routed;
  ok('layouts wrap instead of clipping', all.includes('flex-wrap:wrap'));
  ok('panels are fluid width', ready.includes('max-width:100%'));
  ok('touch targets >= 44px', all.includes('min-height:48') && ready.includes('min-height:44'));
  ok('amounts break instead of overflowing', ready.includes('overflow-wrap:anywhere') && routed.includes('overflow-wrap:anywhere'));
  ok('no fixed-pixel page widths', !/width:\d{3,}px/.test(all));
  ok('no clipped addresses without break rules', !routed.includes('0x') || routed.includes('break-all') || routed.includes('anywhere'));
}

async function statics() {
  console.log('── static: wired surfaces ──────────────────────────────────');
  const widget = read('src/components/CheckoutWidget.tsx');
  ok('widget renders the pay-in selector', widget.includes('<PayTokenSelector') && widget.includes("PayTokenSelector }"));
  ok('widget renders the quote panel', widget.includes('<QuotePanel') && widget.includes('panelState'));
  ok('widget drives quotes from the hook', widget.includes('useRoutingQuote') && widget.includes('routing.refresh'));
  ok('widget approve→route execution from the server quote', widget.includes("functionName: 'approve'") && widget.includes("functionName: 'route'") && widget.includes('live.raw.router') && widget.includes('live.raw.minOutputAmount'));
  ok('widget guards execution on a live quote', widget.includes("routing.status === 'ready'") && widget.includes('Quote expired — get a fresh quote'));
  ok('widget pay button names the quoted input', widget.includes('`Pay ${routing.quote.payAmountDisplay} ${routing.quote.paySymbol}`'));
  ok('widget balance is pay-token aware', widget.includes('Your {paySymbol} balance') && widget.includes('balanceOf') && widget.includes('selectedPayToken.address'));
  ok('widget insufficient message names the pay token', widget.includes('Insufficient ${paySymbol} balance'));
  ok('widget success splits converted X vs Y', widget.includes('isConvertedSuccess') && widget.includes('<RoutedReceipt'));
  // The zero address is the pre-existing unreadable-balance placeholder
  // (both balance reads), not a venue — strip it before asserting.
  ok('widget signs no hardcoded venue', !/0x[0-9a-fA-F]{40}/.test(widget.replace(/0x0{40}/g, '')));
  ok('widget copy avoids DEX vocabulary', !/swap|liquidity/i.test(widget));
  const hook = read('src/components/checkout/routing/useRoutingQuote.ts');
  ok('hook posts symbol-only quote requests', hook.includes("'/api/payments/quote'") && hook.includes('payToken: paySymbol'));
  ok('hook counts down server expiry', hook.includes('expiresAtMs') && hook.includes('secondsLeft'));
  ok('hook auto re-quotes on expiry', hook.includes('refreshing') && hook.includes('autoRef'));
  ok('hook honors server direct answers', hook.includes('converted') && hook.includes('INITIAL'));

  const settings = read('src/app/merchant/settings/page.tsx');
  ok('settings exposes settlement currency choice', settings.includes('Settlement currency') && settings.includes("'USDC', 'EURC'"));
  ok('settings explains future-only scope', settings.includes('Existing invoices are unchanged'));
  ok('settings saves via the preference endpoint', settings.includes("'/api/merchant/me'") && settings.includes('settlementToken: symbol'));

  const dash = read('src/app/merchant/dashboard/page.tsx');
  ok('dashboard defaults creation to the preference', dash.includes('settlementPreference') && dash.includes('setSettlementDefault'));
  ok('dashboard names the default on the form', dash.includes('New links settle in'));
  ok('dashboard history splits paid-with', dash.includes('Paid with') && dash.includes('payment.payToken'));
  ok('dashboard keeps per-row currency', dash.includes('{payment.currency}'));

  const invoice = read('src/components/Invoice.tsx');
  ok('invoice splits routed receipt rows', invoice.includes('Paid with') && invoice.includes('Merchant received') && invoice.includes('isConverted'));
  const checkoutPage = read('src/app/checkout/[reference]/page.tsx');
  ok('checkout passes pay identity to the invoice', checkoutPage.includes('payToken: payment.payToken'));
  const embed = read('src/app/checkout/embed/[reference]/page.tsx');
  ok('embed passes pay identity to the paid card', embed.includes('payTokenSymbol'));
  const verify = read('src/app/api/payments/verify/[reference]/route.ts');
  ok('verify exposes payToken + conversion', verify.includes('payToken,') && verify.includes('conversion,') && verify.includes('payTokenView'));
  const allRoute = read('src/app/api/payments/all/route.ts');
  ok('payments/all exposes payToken + conversion', allRoute.includes('payToken: payTokenView') && allRoute.includes('conversion: conversionView'));
  const me = read('src/app/api/merchant/me/route.ts');
  ok('merchant/me exposes the preference', me.includes('settlementPreference'));
}

async function handlers() {
  console.log('── handler: preference + verify read-model (dev DB) ───────');
  // NOTE: route modules are imported dynamically AFTER the .env.local
  // override above (module-level JWT-secret capture depends on it).
  const { GET: meGET, PATCH: mePATCH } = await import('@/app/api/merchant/me/route');
  const { GET: verifyGET } = await import('@/app/api/payments/verify/[reference]/route');

  const req = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const apiKey = `ui-key-${Date.now()}`;
  const m = await (prisma as any).merchant.create({
    data: {
      email: `${REF}@test.local`, businessName: `UiTest ${REF}`,
      passwordHash: 'x', apiKey, walletAddress: MERCHANT, verified: true, active: true,
    },
  });
  const jwt = await new SignJWT({ merchantId: m.id })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(requireJwtSecret('MERCHANT_JWT_SECRET'));
  const cookie = { cookie: `merchant_token=${jwt}` };

  const g0: any = await meGET(req('http://localhost/api/merchant/me', 'GET', undefined, cookie));
  const g0b = await g0.json();
  ok('GET /me returns USDC default preference', g0.status === 200 && g0b?.settlementPreference?.symbol === 'USDC', `${g0.status} ${JSON.stringify(g0b?.settlementPreference)}`);
  const p1: any = await mePATCH(req('http://localhost/api/merchant/me', 'PATCH', { settlementToken: 'EURC' }, cookie));
  ok('PATCH preference → EURC', p1.status === 200 && (await p1.json())?.settlementPreference?.symbol === 'EURC', `${p1.status}`);
  const g1: any = await meGET(req('http://localhost/api/merchant/me', 'GET', undefined, cookie));
  ok('GET /me reflects the EURC preference', (await g1.json())?.settlementPreference?.symbol === 'EURC');

  // Routed fixture: EURC invoice paid in USDC, live QUOTED conversion.
  const routed = await prisma.paymentLog.create({
    data: {
      reference: `${REF}-routed`, amount: 27.01, currency: 'USDC', tokenAddress: USDC,
      payTokenAddress: EURC, chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout',
      merchant: `UiTest ${REF}`, merchantSCA: MERCHANT, status: 'PENDING',
    },
  });
  await (prisma as any).paymentConversion.create({
    data: {
      paymentLogId: routed.id, status: 'QUOTED',
      inputTokenAddress: EURC, inputAmount: '25000000',
      outputTokenAddress: USDC, quotedOutputAmount: '27010000', minOutputAmount: '26730000',
      quoteExpiresAt: new Date(Date.now() + 4 * 60_000),
      quoteHash: `0x${'11'.repeat(32)}`, poolAddress: POOL, idempotencyKey: `ui-${Date.now()}`,
    },
  });
  const direct = await prisma.paymentLog.create({
    data: {
      reference: `${REF}-direct`, amount: 10, currency: 'EURC', tokenAddress: EURC,
      chain: 'Arc Testnet v1.0', senderEmail: 'pending@checkout',
      merchant: `UiTest ${REF}`, merchantSCA: MERCHANT, status: 'PENDING',
    },
  });
  const callVerify = (reference: string) =>
    (verifyGET as any)(
      new NextRequest(`http://localhost/api/payments/verify/${reference}`),
      { params: Promise.resolve({ reference }) }
    );

  const vr: any = await callVerify(`${REF}-routed`);
  const vrb = await vr.json();
  ok('verify: routed pay token is authoritative X', vr.status === 200 && vrb?.data?.payToken?.symbol === 'EURC', `${vr.status} ${JSON.stringify(vrb?.data?.payToken)}`);
  ok('verify: routed settlement stays Y', vrb?.data?.token?.symbol === 'USDC');
  ok('verify: routed conversion displays exposed', vrb?.data?.conversion?.inputAmountDisplay === '25' && vrb?.data?.conversion?.quotedOutputDisplay === '27.01' && vrb?.data?.conversion?.status === 'QUOTED');
  const vd: any = await callVerify(`${REF}-direct`);
  const vdb = await vd.json();
  ok('verify: direct pay token reads as settlement', vdb?.data?.payToken?.symbol === 'EURC' && vdb?.data?.token?.symbol === 'EURC');
  ok('verify: direct conversion is null', vdb?.data?.conversion === null);

  // cleanup
  await (prisma as any).paymentConversion.deleteMany({ where: { paymentLogId: { in: [routed.id, direct.id] } } });
  await prisma.paymentLog.deleteMany({ where: { merchant: `UiTest ${REF}` } });
  await (prisma as any).merchant.delete({ where: { id: m.id } });
  ok('test rows cleaned up', (await prisma.paymentLog.count({ where: { merchant: `UiTest ${REF}` } })) === 0);
}

async function main() {
  await unit();
  await renders();
  await statics();
  await handlers();
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((e) => { console.error('routing-ui-tests crashed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
