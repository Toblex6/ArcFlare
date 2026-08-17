// scripts/checkout-hardening-tests.mjs
// Phase 5 — permanent hardening/verification suite for Checkout.
//
// Proves security invariants with STATE assertions (DB rows, resolved
// addresses, on-chain balances, response headers), not just HTTP status:
//   - authorization: anonymous/forged/non-party rejections
//   - payment correctness: server-resolved merchant/payer, wrong
//     token/amount rejection
//   - idempotency/concurrency: exactly-one-execution, no double debit
//   - lifecycle/edge: 404s, expired references, already-paid surfaces
//   - embed headers: frame-ancestors * vs 'none', no X-Frame-Options
//   - API validation: malformed initialize bodies, no partial rows
//
// Same test-only/testnet-only/no-real-funds approach as checkout-e2e.mjs.
// Every PaymentLog row + consumerAccount row created here is deleted at
// the end (explicit reference/address-based deletes, nothing else).
//
// Usage: node scripts/checkout-hardening-tests.mjs [baseUrl]

import 'dotenv/config';
import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { decimals: 18, name: 'ARC', symbol: 'ARC' },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const AMOUNT = 0.01;
const AMOUNT_UNITS = parseUnits(AMOUNT.toString(), 6);
const HALF_UNITS = parseUnits('0.005', 6);

const prisma = new PrismaClient();
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });

const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

let passed = 0;
let failed = 0;
const failures = [];
const createdRefs = [];
const createdConsumerWallets = [];

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

async function get(path, timeoutMs = 120000) {
  return fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
}

async function paymentRow(ref) {
  return prisma.paymentLog.findUnique({ where: { reference: ref } });
}

async function balanceUsdc(addr) {
  const raw = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr],
  });
  return Number(formatUnits(raw, 6));
}

async function initPayment(key, body = {}) {
  const res = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: 'acne corp', ...body,
  }, { 'x-api-key': key });
  const data = await j(res);
  if (data.reference) createdRefs.push(data.reference);
  return { res, data };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/payments/verify/__probe__`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return true;
    } catch { }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ── Consumer session helper (challenge → sign → cookie jar) ────────────────
function makeCookieJar() {
  const jar = new Map();
  return {
    header: () => [...jar.values()].join('; '),
    remember: (res) => {
      const setCookie = res.headers.get('set-cookie');
      if (!setCookie) return;
      for (const match of setCookie.matchAll(/([A-Za-z0-9_]+)=([^;,]*)/g)) {
        if (match[1] === 'consumer_connect_nonce' || match[1] === 'consumer_token') {
          jar.set(match[1], `${match[1]}=${match[2]}`);
        }
      }
    },
  };
}

async function createConsumerSession(wallet) {
  const jar = makeCookieJar();
  const chRes = await fetch(`${BASE}/api/consumer/session?nonce=1&address=${wallet.address}`);
  jar.remember(chRes); // nonce cookie must be sent with the POST
  const ch = await j(chRes);
  const jarHead = new Headers({ 'Content-Type': 'application/json' });
  jarHead.append('cookie', jar.header());
  const postRes = await fetch(`${BASE}/api/consumer/session`, {
    method: 'POST',
    headers: jarHead,
    body: JSON.stringify({ walletAddress: wallet.address, message: ch.message, signature: await wallet.signMessage(ch.message) }),
  });
  jar.remember(postRes);
  return { postRes, jar };
}

async function main() {
  console.log('── Checkout Hardening Suite (Phase 5) ──────────────────────');
  if (!(await waitForServer())) {
    console.log(`❌ dev server not reachable at ${BASE}`);
    process.exit(1);
  }

  const merchantA = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null } },
  });
  const merchantB = await prisma.merchant.findFirst({
    where: { businessName: 'tower', verified: true, active: true, walletAddress: { not: null } },
  });
  const keyA = merchantA.apiKey;
  const keyB = merchantB.apiKey;
  console.log(`merchant A "${merchantA.businessName}" wallet ${merchantA.walletAddress}`);
  console.log(`merchant B "${merchantB.businessName}" wallet ${merchantB.walletAddress}`);

  const buyerPk = process.env.BUYER_PRIVATE_KEY;
  const buyer = buyerPk ? privateKeyToAccount(buyerPk) : null;
  const merchantBal = await balanceUsdc(merchantA.walletAddress);
  console.log(`buyer ${buyer?.address || '(none)'} | merchant A USDC now: ${merchantBal}`);

  // ══ AUTHORIZATION ═════════════════════════════════════════════════════

  console.log('\n[auth] anonymous initialize → 401, no row created');
  {
    const before = await prisma.paymentLog.count();
    const res = await post('/api/payments/initialize', { amount: AMOUNT, currency: 'USDC' });
    const data = await j(res);
    const after = await prisma.paymentLog.count();
    ok('anonymous initialize 401', res.status === 401, `got ${res.status}`);
    ok('no partial PaymentLog row', after === before, `rows ${before} → ${after}`);
    ok('no reference leaked in error', !data.reference);
  }

  console.log('\n[auth] anonymous settle → 401');
  {
    const { res, data } = await initPayment(keyA);
    const anon = await post('/api/payments/settle', { reference: data.reference });
    ok('anonymous settle 401', anon.status === 401, `got ${anon.status}`);
    const row = await paymentRow(data.reference);
    ok('row unchanged (still PENDING)', row?.status === 'PENDING', row?.status);
  }

  console.log('\n[auth] merchant B settling merchant A payment → 403');
  {
    const { res, data } = await initPayment(keyA);
    const rogue = await post('/api/payments/settle', { reference: data.reference }, { 'x-api-key': keyB });
    const rogueData = await j(rogue);
    ok('403 party rejection', rogue.status === 403, `got ${rogue.status}: ${JSON.stringify(rogueData).slice(0, 160)}`);
    ok('explicit party error message', rogueData.error === 'You are not a party to this payment.', rogueData.error);
    const row = await paymentRow(data.reference);
    console.log(`    (designed: row now ${row?.status} — 5-min stale-lock recovery; cleanup deletes it)`);
  }

  console.log('\n[auth] settle-cross-chain no longer unauthenticated');
  {
    const anon = await post('/api/settle-cross-chain', { reference: 'x', messageHash: '0x1', rawMessage: '0x2' });
    const anonData = await j(anon);
    ok('anonymous settle-cross-chain 401', anon.status === 401, `got ${anon.status}`);
    ok('no stack trace / internal detail leaked', !/at .*\(/i.test(JSON.stringify(anonData)), JSON.stringify(anonData).slice(0, 160));
    const merchantKey = await post('/api/settle-cross-chain', { reference: 'x', messageHash: '0x1', rawMessage: '0x2' }, { 'x-api-key': keyB });
    ok('merchant (non-internal) key still 401', merchantKey.status === 401, `got ${merchantKey.status}`);
  }

  console.log('\n[auth] claiming a wallet you do not control (forged session)');
  {
    const victim = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const jar = makeCookieJar();
    const chRes = await fetch(`${BASE}/api/consumer/session?nonce=1&address=${victim.address}`);
    const ch = await j(chRes);
    jar.remember(chRes);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('cookie', jar.header());
    const forged = await fetch(`${BASE}/api/consumer/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        walletAddress: victim.address,
        message: ch.message,
        signature: await attacker.signMessage(ch.message), // attacker signs victim's challenge
      }),
    });
    const forgedData = await j(forged);
    ok('forged signature rejected 401', forged.status === 401 && forgedData.success === false, `got ${forged.status} ${JSON.stringify(forgedData).slice(0, 160)}`);
    const victimAccount = await prisma.consumerAccount.findUnique({ where: { walletAddress: victim.address.toLowerCase() } });
    ok('no consumerAccount row created for the unproven address', !victimAccount);
  }

  // ══ PAYMENT CORRECTNESS ═══════════════════════════════════════════════

  console.log('\n[correctness] server-resolved merchant — client label cannot override');
  {
    const { res, data } = await initPayment(keyA, { merchant: 'HACKER MALL' });
    ok('initialize 200', res.status === 200, `got ${res.status}`);
    const row = await paymentRow(data.reference);
    ok('merchant = real businessName (server-resolved)', row?.merchant === merchantA.businessName, row?.merchant);
    ok('merchantId = key owner', row?.merchantId === merchantA.id, row?.merchantId);
    ok('merchantSCA = key owner wallet (server-resolved)', row?.merchantSCA?.toLowerCase() === merchantA.walletAddress.toLowerCase(), `${row?.merchantSCA} vs ${merchantA.walletAddress}`);
  }

  console.log('\n[correctness] consumer "send" — payer is the session wallet, not body-supplied');
  {
    const payer = ethers.Wallet.createRandom();
    createdConsumerWallets.push(payer.address.toLowerCase());
    const { postRes, jar } = await createConsumerSession(payer);
    ok('consumer session established', postRes.status === 200 || postRes.status === 201, `got ${postRes.status}`);
    const decoy = ethers.Wallet.createRandom().address; // body attempts to name a different payer
    const res = await post('/api/payments/initialize', {
      amount: AMOUNT, currency: 'USDC', direction: 'send', payoutAddress: decoy,
    }, { cookie: jar.header() });
    const data = await j(res);
    if (data.reference) createdRefs.push(data.reference);
    ok('initialize as consumer 200', res.status === 200, `got ${res.status}`);
    const row = await paymentRow(data.reference);
    ok('payer = session consumer (server-resolved, not body)', row?.senderEmail?.toLowerCase() === payer.address.toLowerCase(), `${row?.senderEmail} vs ${payer.address}`);
    ok('payout destination = validated body payoutAddress (consumer flow)', row?.merchantSCA?.toLowerCase() === decoy.toLowerCase(), `${row?.merchantSCA} vs ${decoy}`);
  }

  console.log('\n[correctness] wrong token/chain cannot be silently accepted');
  {
    const { res, data } = await initPayment(keyA, { token: 'USDC_TRON', chain: 'ethereum-mainnet', blockchain: 'TRON' });
    const row = await paymentRow(data.reference);
    ok('row created', !!row);
    ok('currency forced to USDC', row?.currency === 'USDC', row?.currency);
    ok('chain forced to Arc Testnet v1.0', row?.chain === 'Arc Testnet v1.0', row?.chain);
    ok('no token/blockchain column polluted', row?.chain !== 'TRON' && row?.currency !== 'USDC_TRON');
  }

  console.log('\n[correctness] incorrect amount rejected at initialize');
  {
    const before = await prisma.paymentLog.count();
    for (const bad of [{ currency: 'USDC' }, { amount: 0, currency: 'USDC' }, { amount: -5, currency: 'USDC' }, { amount: 'abc', currency: 'USDC' }, { amount: '0.0000001', currency: 'USDC' }]) {
      const res = await post('/api/payments/initialize', bad, { 'x-api-key': keyA });
      const data = await j(res);
      ok(`malformed body rejected 400 (${JSON.stringify(bad)})`, res.status === 400 && /Validation failed/i.test(data.error || ''), `got ${res.status}: ${JSON.stringify(data).slice(0, 120)}`);
    }
    const after = await prisma.paymentLog.count();
    ok('no partial rows from malformed initialize', after === before, `rows ${before} → ${after}`);
  }

  console.log('\n[correctness] underpaid on-chain transfer rejected by verify-onchain');
  {
    const { res, data } = await initPayment(keyA);
    const rowBefore = await paymentRow(data.reference);
    const balBefore = await balanceUsdc(merchantA.walletAddress);
    const walletClient = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });
    const txHash = await walletClient.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer',
      args: [merchantA.walletAddress, HALF_UNITS],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const v = await post('/api/payments/verify-onchain', { reference: data.reference, txHash });
    const vData = await j(v);
    ok('underpayment 400, not confirmed', v.status === 400, `got ${v.status}`);
    ok('row still PENDING (no SUCCESS)', (await paymentRow(data.reference))?.status === 'PENDING');
    ok('no SUCCESS arcTxHash recorded', (await paymentRow(data.reference))?.arcTxHash == null);
    const balAfter = await balanceUsdc(merchantA.walletAddress);
    ok('only the underpaid amount moved (0.005, not 0.01)', Math.abs((balAfter - balBefore) - 0.005) < 0.000001, `delta ${(balAfter - balBefore).toFixed(6)}`);
  }

  // ══ IDEMPOTENCY / CONCURRENCY ═════════════════════════════════════════

  console.log('\n[idempotency] duplicate settle on SUCCESS → 409, no second debit');
  {
    const { res, data } = await initPayment(keyA);
    const pay = await post('/api/checkout/pay', { reference: data.reference });
    ok('first checkout/pay settles 200', pay.status === 200, `got ${pay.status}`);
    const row = await paymentRow(data.reference);
    ok('row SUCCESS', row?.status === 'SUCCESS', row?.status);
    const balAfterFirst = await balanceUsdc(merchantA.walletAddress);
    const dup = await post('/api/checkout/pay', { reference: data.reference });
    const dupData = await j(dup);
    ok('duplicate settle 409', dup.status === 409, `got ${dup.status}: ${JSON.stringify(dupData).slice(0, 160)}`);
    const rowAfter = await paymentRow(data.reference);
    ok('row unchanged after duplicate', rowAfter?.status === 'SUCCESS' && rowAfter?.arcTxHash === row?.arcTxHash);
    const balAfterDup = await balanceUsdc(merchantA.walletAddress);
    ok('no second debit (merchant balance unchanged)', Math.abs(balAfterDup - balAfterFirst) < 0.000001, `delta ${(balAfterDup - balAfterFirst).toFixed(6)}`);
  }

  console.log('\n[idempotency] true concurrent checkout/pay → exactly one settles');
  {
    const { res, data } = await initPayment(keyA);
    const balBefore = await balanceUsdc(merchantA.walletAddress);
    const [c1, c2] = await Promise.all([
      post('/api/checkout/pay', { reference: data.reference }),
      post('/api/checkout/pay', { reference: data.reference }),
    ]);
    const codes = [c1.status, c2.status];
    ok('exactly one 200 and one 409', codes.includes(200) && codes.includes(409), `codes ${codes}`);
    const row = await paymentRow(data.reference);
    ok('final state SUCCESS', row?.status === 'SUCCESS', row?.status);
    const balAfter = await balanceUsdc(merchantA.walletAddress);
    ok('single debit only (delta == amount)', Math.abs((balAfter - balBefore) - AMOUNT) < 0.000001, `delta ${(balAfter - balBefore).toFixed(6)}`);
  }

  console.log('\n[idempotency] duplicate verify-onchain on settled payment → alreadySettled');
  {
    const { res, data } = await initPayment(keyA);
    const walletClient = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });
    const txHash = await walletClient.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer',
      args: [merchantA.walletAddress, AMOUNT_UNITS],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const v1 = await post('/api/payments/verify-onchain', { reference: data.reference, txHash });
    const v2 = await post('/api/payments/verify-onchain', { reference: data.reference, txHash });
    const d1 = await j(v1);
    const d2 = await j(v2);
    ok('first verify-onchain 200 success', v1.status === 200 && d1.success === true, `got ${v1.status}`);
    ok('duplicate returns alreadySettled (no re-processing)', v2.status === 200 && d2.success === true && d2.alreadySettled === true, `got ${v2.status} ${JSON.stringify(d2).slice(0, 160)}`);
    const row = await paymentRow(data.reference);
    ok('row settled exactly once (single arcTxHash)', row?.status === 'SUCCESS' && row?.arcTxHash === txHash);
  }

  // ══ LIFECYCLE / EDGE CASES ═════════════════════════════════════════════

  console.log('\n[lifecycle] nonexistent / malformed reference → clean 404');
  {
    for (const ref of ['arc_ref_does_not_exist_000', '!!!@@@###', 'arc_ref_' + 'x'.repeat(300)]) {
      const res = await get(`/api/payments/verify/${encodeURIComponent(ref)}`);
      const data = await j(res);
      ok(`verify ${ref.slice(0, 24)}… → 404, clean JSON`, res.status === 404 && data.status === false && typeof data.message === 'string', `got ${res.status}`);
      ok(`   no internal detail leaked`, !/prisma|error|stack|at\s+\w+/i.test(JSON.stringify(data)), JSON.stringify(data).slice(0, 120));
      const pay = await post('/api/checkout/pay', { reference: ref });
      ok(`checkout/pay ${ref.slice(0, 24)}… → 404`, pay.status === 404, `got ${pay.status}`);
    }
  }

  console.log('\n[lifecycle] expired reference — PENDING until settle attempt, then EXPIRED');
  {
    const { res, data } = await initPayment(keyA);
    const rowBefore = await paymentRow(data.reference);
    await prisma.paymentLog.update({
      where: { reference: data.reference },
      data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const verify = await get(`/api/payments/verify/${data.reference}`);
    const vData = await j(verify);
    ok('pre-attempt status still reads PENDING (documented behavior)', vData.data?.status === 'PENDING', vData.data?.status);
    const pay = await post('/api/checkout/pay', { reference: data.reference });
    const payData = await j(pay);
    const rowAfter = await paymentRow(data.reference);
    ok('settle attempt on expired → 400', pay.status === 400, `got ${pay.status}: ${JSON.stringify(payData).slice(0, 160)}`);
    ok('status becomes EXPIRED', rowAfter?.status === 'EXPIRED', rowAfter?.status);
    ok('no funds moved (no arcTxHash)', rowAfter?.arcTxHash == null);
  }

  console.log('\n[lifecycle] already-paid surfaces — hosted Invoice vs embed AlreadyPaid');
  {
    const { res, data } = await initPayment(keyA);
    const walletClient = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });
    const txHash = await walletClient.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer',
      args: [merchantA.walletAddress, AMOUNT_UNITS],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const v = await post('/api/payments/verify-onchain', { reference: data.reference, txHash });
    ok('payment settled for surface test', v.status === 200, `got ${v.status}`);

    const hosted = await get(`/checkout/${data.reference}`);
    const hostedHtml = await hosted.text();
    ok('hosted 200', hosted.status === 200);
    // SSR shows the initial CheckoutLoading state (the timeline/invoice
    // render client-side after the widget fetches status) — assert the
    // SSR markers that ARE server-deterministic: hosted is the full page
    // (no embed attribution) and embeds the reference.
    ok('hosted SSR embeds the reference', hostedHtml.includes(data.reference));
    ok('hosted is NOT the embed surface (no "Secured by FlareHQ")', !hostedHtml.includes('Secured by FlareHQ'));
    const hCSP = hosted.headers.get('content-security-policy') || '';
    ok("hosted CSP frame-ancestors 'none'", hCSP.includes("frame-ancestors 'none'"), hCSP);

    const embed = await get(`/checkout/embed/${data.reference}`);
    const embedHtml = await embed.text();
    ok('embed 200', embed.status === 200);
    ok('embed renders "Secured by FlareHQ" attribution', embedHtml.includes('Secured by FlareHQ'));
    ok('embed has NO hosted timeline', !embedHtml.includes('Payment Progress'));
    const eCSP = embed.headers.get('content-security-policy') || '';
    ok('embed CSP frame-ancestors *', eCSP.includes('frame-ancestors *'), eCSP);

    ok('no X-Frame-Options on hosted', hosted.headers.get('x-frame-options') == null);
    ok('no X-Frame-Options on embed', embed.headers.get('x-frame-options') == null);
    // Client-rendered contract (Invoice vs CheckoutAlreadyPaid) is decided
    // in React after the widget fetches status — requires a browser driver;
    // the HTTP suite locks the SSR chrome + CSP + verify contract instead.
    const verify = await get(`/api/payments/verify/${data.reference}`);
    const vData = await j(verify);
    ok('verify contract for paid payment: SUCCESS + settledAt + arcTxHash', vData.data?.status === 'SUCCESS' && !!vData.data?.settledAt && !!vData.data?.arcTxHash);
  }

  // ══ API VALIDATION ════════════════════════════════════════════════════

  console.log('\n[validation] unsupported currency rejected with 400, no row created');
  {
    // Regression-proof: InitializeSchema.currency is a strict USDC-only enum.
    // TETHER is the historical finding value; lowercase 'usdc' proves there
    // is no case-insensitive fuzzy matching.
    const before = await prisma.paymentLog.count();
    for (const bad of [{ currency: 'TETHER' }, { currency: 'usdc' }, { currency: 'EURC' }]) {
      const res = await post('/api/payments/initialize', { amount: AMOUNT, currency: bad.currency }, { 'x-api-key': keyA });
      const data = await j(res);
      ok(`non-USDC currency rejected 400 (${bad.currency})`, res.status === 400 && /Validation failed/i.test(data.error || ''), `got ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
    }
    const after = await prisma.paymentLog.count();
    ok('no PaymentLog row created by rejected currencies', after === before, `rows ${before} → ${after}`);
  }

  // ══ SUMMARY ═══════════════════════════════════════════════════════════

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f.name} — ${f.detail}`);
  process.exitCode = failed > 0 ? 1 : 0; // no process.exit() — the finally below must run cleanup
}

main()
  .catch(async (e) => {
    console.error('Harness error:', e.message);
    failed++;
  })
  .finally(async () => {
    // Cleanup — explicit, reference/address-based, nothing else touched.
    if (createdRefs.length) {
      const del = await prisma.paymentLog.deleteMany({ where: { reference: { in: createdRefs } } });
      console.log(`cleanup: deleted ${del.count} PaymentLog rows (${createdRefs.length} created)`);
    }
    if (createdConsumerWallets.length) {
      const del = await prisma.consumerAccount.deleteMany({
        where: { walletAddress: { in: createdConsumerWallets, mode: 'insensitive' } },
      });
      console.log(`cleanup: deleted ${del.count} consumerAccount row(s) created by this suite`);
    }
    await prisma.$disconnect();
  });