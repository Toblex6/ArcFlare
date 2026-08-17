// scripts/checkout-e2e.mjs
// Local Checkout readiness proof against the EXISTING payment foundation.
// Proves: initialize -> PaymentLog -> hosted/embed checkout resolve ->
// onchain payment + verify-onchain -> /api/checkout/pay -> settle ->
// verify -> unauthorized-settle rejection -> duplicate/concurrent-settle
// idempotency. Uses only existing testnet/dev credentials. No new tables,
// no state machine changes, no contracts, no real funds.
//
// Usage: node scripts/checkout-e2e.mjs [baseUrl]

import 'dotenv/config';
import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

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
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';
const AMOUNT = 0.01;
const AMOUNT_UNITS = parseUnits(AMOUNT.toString(), 6);

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
const results = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    results.push({ name, pass: true });
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    results.push({ name, pass: false, detail });
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function j(res) {
  try { return await res.json(); } catch { return {}; }
}

async function post(path, body, headers = {}, timeoutMs = 160000) {
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

function snapshot(label, p) {
  console.log(`    [${label}] ${JSON.stringify({
    reference: p.reference,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    direction: p.direction,
    merchant: p.merchant,
    merchantId: p.merchantId,
    merchantSCA: p.merchantSCA,
    senderEmail: p.senderEmail,
    payerSCA: p.payerSCA,
    arcTxHash: p.arcTxHash,
    circleTxId: p.circleTxId,
    chain: p.chain,
    createdAt: p.timestamp,
    expiresAt: p.expiresAt,
  })}`);
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

async function main() {
  console.log('── Checkout E2E (existing foundation) ────────────────────────');
  console.log(`base: ${BASE}`);

  if (!(await waitForServer())) {
    console.log(`❌ dev server not reachable at ${BASE}`);
    process.exit(1);
  }

  // 0. Merchants from the local dev DB (verified + active + wallet configured).
  const merchantA = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null } },
  });
  const merchantB = await prisma.merchant.findFirst({
    where: { businessName: 'tower', verified: true, active: true, walletAddress: { not: null } },
  });
  if (!merchantA || !merchantB) {
    console.log('❌ could not locate test merchants in local DB');
    process.exit(1);
  }
  const keyA = merchantA.apiKey;
  const keyB = merchantB.apiKey;
  console.log(`merchant A: "${merchantA.businessName}" (${keyA.slice(0, 12)}…, wallet ${merchantA.walletAddress})`);
  console.log(`merchant B: "${merchantB.businessName}" (${keyB.slice(0, 12)}…, wallet ${merchantB.walletAddress})`);

  // 1. Funds (read-only) — decide which payment path is available.
  const buyerPk = process.env.BUYER_PRIVATE_KEY;
  const buyerAddress = process.env.BUYER_ADDRESS;
  let buyer = null;
  if (buyerPk) {
    try {
      buyer = privateKeyToAccount(buyerPk);
      if (buyerAddress && buyer.address.toLowerCase() !== buyerAddress.toLowerCase()) {
        console.log(`⚠️ BUYER_ADDRESS (${buyerAddress}) does not match key's address (${buyer.address})`);
      }
    } catch { console.log('⚠️ BUYER_PRIVATE_KEY invalid'); }
  }
  const bal = async (addr) => ({
    usdc: Number(formatUnits(await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }), 6)),
    arc: Number(formatUnits(await publicClient.getBalance({ address: addr }), 18)),
  });
  const buyerBal = buyer ? await bal(buyer.address) : null;
  const defaultPayerBal = await bal(DEFAULT_PAYER_SCA);
  console.log(`buyer wallet ${buyer ? buyer.address : '(none)'}: USDC ${buyerBal?.usdc ?? 'n/a'} | ARC ${buyerBal?.arc ?? 'n/a'}`);
  console.log(`default payer ${DEFAULT_PAYER_SCA}: USDC ${defaultPayerBal.usdc} | ARC ${defaultPayerBal.arc}`);
  const pathAFeasible = !!buyer && (buyerBal.usdc >= AMOUNT) && buyerBal.arc > 0;
  const pathBFeasible = defaultPayerBal.usdc >= AMOUNT;

  // 2. Initialize payment A (merchant checkout).
  console.log('\n[1] initialize (merchant path)');
  const initA = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const initAData = await j(initA);
  ok('initialize 200', initA.status === 200, `got ${initA.status}`);
  ok('initialize returns reference', !!initAData.reference, JSON.stringify(initAData).slice(0, 200));
  const refA = initAData.reference;
  let row = await paymentRow(refA);
  ok('PaymentLog created', !!row);
  if (row) {
    ok('PaymentLog status PENDING', row.status === 'PENDING', row.status);
    ok('merchantSCA = merchant A wallet (server-resolved)', row.merchantSCA?.toLowerCase() === merchantA.walletAddress.toLowerCase(), `${row.merchantSCA} vs ${merchantA.walletAddress}`);
    ok('merchantId = merchant A id', row.merchantId === merchantA.id);
    ok('merchant = businessName', row.merchant === 'acne corp', row.merchant);
    ok('amount/currency correct', row.amount === AMOUNT && row.currency === 'USDC');
    ok('expiresAt ~ +120m', row.expiresAt && Math.abs(new Date(row.expiresAt) - new Date(row.timestamp)) > 100 * 60_000 && Math.abs(new Date(row.expiresAt) - new Date(row.timestamp)) < 140 * 60_000);
    snapshot('before', row);
  }

  // 3. Hosted checkout resolves.
  console.log('\n[2] hosted checkout');
  const hosted = await get(`/checkout/${refA}`);
  const hostedHtml = await hosted.text();
  ok('GET /checkout/<ref> 200', hosted.status === 200, `got ${hosted.status}`);
  ok('serves text/html', (hosted.headers.get('content-type') || '').includes('text/html'));
  ok('body contains reference', hostedHtml.includes(refA));

  // 4. Embedded checkout resolves.
  console.log('\n[3] embedded checkout');
  const embed = await get(`/checkout/embed/${refA}`);
  const embedHtml = await embed.text();
  ok('GET /checkout/embed/<ref> 200', embed.status === 200, `got ${embed.status}`);
  ok('embed serves text/html', (embed.headers.get('content-type') || '').includes('text/html'));
  ok('embed body contains reference', embedHtml.includes(refA));

  // 5. Payment path A — onchain USDC transfer + verify-onchain (widget path).
  console.log('\n[4] payment path A (onchain transfer + verify-onchain)');
  if (!pathAFeasible) {
    console.log(`  ⚠️ SKIPPED — buyer wallet needs ≥ ${AMOUNT} testnet USDC and ARC gas (has USDC ${buyerBal?.usdc ?? 0}, ARC ${buyerBal?.arc ?? 0})`);
    results.push({ name: 'path A executed', pass: false, detail: 'unfunded buyer wallet' });
    failed++;
  } else {
    const walletClient = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });
    let txHash;
    try {
      txHash = await walletClient.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [merchantA.walletAddress, AMOUNT_UNITS],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      ok('onchain transfer mined (status success)', receipt.status === 'success', `tx ${txHash}`);
      console.log(`    txHash: ${txHash}`);
    } catch (e) {
      ok('onchain transfer mined (status success)', false, e.shortMessage || e.message);
    }
    if (txHash) {
      const vres = await post('/api/payments/verify-onchain', { reference: refA, txHash });
      const vdata = await j(vres);
      ok('verify-onchain 200', vres.status === 200, `got ${vres.status}: ${JSON.stringify(vdata).slice(0, 200)}`);
      ok('verify-onchain success', vdata.success === true);
      row = await paymentRow(refA);
      ok('PaymentLog SUCCESS after verify-onchain', row?.status === 'SUCCESS', row?.status);
      ok('arcTxHash recorded', row?.arcTxHash === txHash, `${row?.arcTxHash} vs ${txHash}`);
      ok('payerSCA = buyer wallet', row?.payerSCA?.toLowerCase() === buyer.address.toLowerCase(), row?.payerSCA);
      ok('senderEmail = buyer wallet', row?.senderEmail?.toLowerCase() === buyer.address.toLowerCase(), row?.senderEmail);
      snapshot('after path A', row);
    }
  }

  // 6. Verify endpoint.
  console.log('\n[5] GET /api/payments/verify/<ref>');
  const vget = await get(`/api/payments/verify/${refA}`);
  const vgetData = await j(vget);
  ok('verify 200', vget.status === 200, `got ${vget.status}`);
  ok('verify status true', vgetData.status === true);
  ok('verify data.status SUCCESS', vgetData.data?.status === 'SUCCESS', vgetData.data?.status);
  ok('verify returns arcTxHash', !!vgetData.data?.arcTxHash);
  ok('verify returns settledAt', !!vgetData.data?.settledAt);

  // 7. Duplicate verify-onchain is idempotent.
  console.log('\n[6] duplicate verify-onchain');
  if (pathAFeasible) {
    const dup = await post('/api/payments/verify-onchain', { reference: refA, txHash: (await paymentRow(refA))?.arcTxHash });
    const dupData = await j(dup);
    ok('duplicate verify-onchain alreadySettled', dupData.success === true && dupData.alreadySettled === true, JSON.stringify(dupData));
  }

  // 8. Duplicate checkout/pay on a settled payment -> 409.
  console.log('\n[7] duplicate checkout/pay on settled payment');
  const dupPay = await post('/api/checkout/pay', { reference: refA });
  const dupPayData = await j(dupPay);
  ok('checkout/pay 409 on settled payment', dupPay.status === 409, `got ${dupPay.status}: ${JSON.stringify(dupPayData).slice(0, 200)}`);

  // 9. Initialize payment B + anonymous settle -> 401, then checkout/pay path B.
  console.log('\n[8] path B via /api/checkout/pay');
  const initB = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const refB = (await j(initB)).reference;
  ok('initialize B 200', initB.status === 200, `got ${initB.status}`);
  const anon = await post('/api/payments/settle', { reference: refB });
  ok('anonymous settle 401', anon.status === 401, `got ${anon.status}`);
  row = await paymentRow(refB);
  ok('PaymentLog B still PENDING after anonymous settle', row?.status === 'PENDING', row?.status);

  if (!pathBFeasible) {
    console.log(`  ⚠️ default payer wallet has ${defaultPayerBal.usdc} testnet USDC (< ${AMOUNT}) — checkout/pay would fail at Circle.`);
    console.log(`  Calling checkout/pay anyway once to record the exact honest failure.`);
    results.push({ name: 'path B executed', pass: false, detail: 'default payer wallet unfunded' });
    failed++;
  }
  const payRes = await post('/api/checkout/pay', { reference: refB });
  const payData = await j(payRes);
  console.log(`  checkout/pay → ${payRes.status}: ${JSON.stringify(payData).slice(0, 300)}`);
  row = await paymentRow(refB);
  if (payRes.status === 200) {
    ok('checkout/pay 200', true);
    ok('settlementType ONCHAIN_SCA_TRANSFER', payData.settlementType === 'ONCHAIN_SCA_TRANSFER', payData.settlementType);
    ok('arcTxHash returned', !!payData.arcTxHash);
    ok('PaymentLog B SUCCESS', row?.status === 'SUCCESS', row?.status);
    ok('circleTxId recorded', !!row?.circleTxId);
    snapshot('after path B', row);
    results.push({ name: 'path B executed', pass: true });
    const txHashB = payData.arcTxHash || row?.arcTxHash;
    if (txHashB) console.log(`    txHash: ${txHashB}`);
  } else {
    ok('checkout/pay 200', false, `got ${payRes.status}: ${JSON.stringify(payData).slice(0, 300)}`);
    snapshot('path B failure state', row);
  }

  // 10. Duplicate checkout/pay on settled payment B -> 409.
  console.log('\n[9] duplicate checkout/pay on settled payment B');
  if (payRes.status === 200) {
    const dupPayB = await post('/api/checkout/pay', { reference: refB });
    const dupPayBData = await j(dupPayB);
    ok('checkout/pay B 409 on settled payment', dupPayB.status === 409, `got ${dupPayB.status}: ${JSON.stringify(dupPayBData).slice(0, 200)}`);
  }

  // 11. Unauthorized settlement — merchant B settling merchant A's payment -> 403.
  console.log('\n[10] unauthorized settlement (merchant B key on merchant A payment)');
  const initC = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const refC = (await j(initC)).reference;
  ok('initialize C 200', initC.status === 200, `got ${initC.status}`);
  const rogue = await post('/api/payments/settle', { reference: refC }, { 'x-api-key': keyB });
  const rogueData = await j(rogue);
  ok('unauthorized settle 403', rogue.status === 403, `got ${rogue.status}: ${JSON.stringify(rogueData).slice(0, 200)}`);
  row = await paymentRow(refC);
  console.log(`    (designed behavior: row left ${row?.status} — stale-lock recovery reclaims it after 5 min)`);

  // 12. Concurrent settlement — two simultaneous checkout/pay calls.
  console.log('\n[11] concurrent settlement (two simultaneous checkout/pay calls)');
  const initD = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const refD = (await j(initD)).reference;
  ok('initialize D 200', initD.status === 200, `got ${initD.status}`);
  const [c1, c2] = await Promise.all([
    post('/api/checkout/pay', { reference: refD }),
    post('/api/checkout/pay', { reference: refD }),
  ]);
  const codes = [c1.status, c2.status].sort();
  const d1 = await j(c1);
  const d2 = await j(c2);
  console.log(`  responses: ${JSON.stringify([{ s: c1.status, b: d1 }, { s: c2.status, b: d2 }]).slice(0, 400)}`);
  ok('exactly one winner (200), one 409 lock rejection', codes[0] === 409 && codes[1] === 200, `codes ${codes}`);
  const loser = c1.status === 409 ? d1 : d2;
  // The loser can be rejected by either guard: checkout/pay's own status
  // gate (if the winner's lock already flipped the row) or settle's atomic
  // lock ("Payment already processing or settled."). Both are valid.
  ok('loser rejected with a 409 idempotency message', loser.error === 'Payment already processing or settled.' || loser.error === 'Payment is not in a payable state.', JSON.stringify(loser).slice(0, 200));
  row = await paymentRow(refD);
  console.log(`  final state of concurrent ref: ${row?.status}`);

  // 13. Summary.
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  ⚠️ not executed / failed: ${r.name} — ${r.detail || ''}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('E2E harness error:', e);
  await prisma.$disconnect();
  process.exit(1);
});