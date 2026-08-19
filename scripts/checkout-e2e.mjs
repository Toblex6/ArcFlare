// scripts/checkout-e2e.mjs
// Local Checkout readiness proof against the EXISTING payment foundation.
// Proves: initialize -> PaymentLog -> hosted/embed checkout resolve ->
// onchain payment + verify-onchain -> unauthorized-settle rejection ->
// duplicate/concurrent-settle idempotency -> payer-control guard on settle
// (merchant/victim/drain rows 403; no platform-default funding without an
// authorized payer) -> deleted /api/checkout/pay (404) -> C2 agentSCA
// ownership -> legitimate internal settle of a platform-agent row (the
// brain A2A flow) still works. Uses only existing testnet/dev credentials.
// No new tables, no state machine changes, no contracts, no real funds
// (except the 0.01 USDC [12] settle from the platform default wallet).
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
const INTERNAL_KEY = process.env.INTERNAL_SETTLEMENT_API_KEY;
const PLATFORM_AGENT = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
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

  // 7. The public platform-funded checkout trigger is GONE (deleted 2026-08-19).
  console.log('\n[7] deleted /api/checkout/pay route → 404');
  const dupPay = await post('/api/checkout/pay', { reference: refA });
  ok('checkout/pay route deleted (404)', dupPay.status === 404, `got ${dupPay.status}`);

  // 8. C1 escape hatch closed at the only remaining door. The audit's chain
  // was: signup → verified → payment-link row ('pending@checkout' payer) →
  // settle with own merchant key → Path B debited DEFAULT_PAYER_WALLET_ID.
  // With the merchant non-address branch removed from settle, a merchant
  // key can no longer settle its own link rows against the platform
  // default wallet. The public checkout/pay door is gone (404 above), so
  // the internal key is the last possible attacker — and settle's guard
  // rejects internal-key settlement of any row whose payer is not the
  // platform agent.
  console.log('\n[8] platform-default funding of a merchant link row → 403');
  const initB = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const refB = (await j(initB)).reference;
  ok('initialize B 200', initB.status === 200, `got ${initB.status}`);
  const anon = await post('/api/payments/settle', { reference: refB });
  ok('anonymous settle 401', anon.status === 401, `got ${anon.status}`);
  row = await paymentRow(refB);
  ok('PaymentLog B still PENDING after anonymous settle', row?.status === 'PENDING', row?.status);

  const payRes = await post('/api/payments/settle', { reference: refB }, { 'x-api-key': INTERNAL_KEY });
  const payData = await j(payRes);
  console.log(`  internal-key settle → ${payRes.status}: ${JSON.stringify(payData).slice(0, 300)}`);
  row = await paymentRow(refB);
  ok('internal-key settle of merchant link row rejected 403', payRes.status === 403, `got ${payRes.status}`);
  ok('rejection is the payer-control guard message', typeof payData.error === 'string' && payData.error.includes('payer is a wallet you do not control'), JSON.stringify(payData).slice(0, 200));
  ok('no settlement happened (no SUCCESS / arcTxHash / circleTxId)', row?.status !== 'SUCCESS' && !row?.arcTxHash && !row?.circleTxId, JSON.stringify({ status: row?.status, arcTxHash: row?.arcTxHash, circleTxId: row?.circleTxId }));
  // The guard now runs BEFORE the atomic lock: the rejected row is left
  // exactly as it was (PENDING) instead of being parked in
  // PROCESSING_ONCHAIN for the stale-lock recovery window.
  ok('row untouched (stays PENDING, no lock flip)', row?.status === 'PENDING', row?.status);
  await prisma.paymentLog.delete({ where: { reference: refB } }).catch(() => { });

  // 9. Non-caller-controlled payers are rejected on settle.
  console.log('\n[9] settle on PENDING rows with non-caller-controlled payers → 403');
  {
    // (a) "merchant names a victim as payer" shape: a row whose payer is a
    // real 0x address neither the merchant nor the platform controls (the
    // audit's settle guard case, created directly with the exact shape
    // initialize produces for such rows). Two separate rows — each guard
    // rejection runs BEFORE the lock now, so the row is left untouched.
    const victimPayer = `0x${'a'.repeat(40)}`;
    const refV = `arc_ref_victim_${Date.now()}`;
    const refV2 = `arc_ref_victim2_${Date.now()}`;
    await prisma.paymentLog.create({
      data: {
        reference: refV, amount: AMOUNT, currency: 'USDC', chain: 'Arc Testnet v1.0',
        senderEmail: victimPayer, direction: 'request', merchant: merchantA.businessName,
        merchantId: merchantA.id, merchantSCA: merchantA.walletAddress,
        status: 'PENDING',
      },
    });
    await prisma.paymentLog.create({
      data: {
        reference: refV2, amount: AMOUNT, currency: 'USDC', chain: 'Arc Testnet v1.0',
        senderEmail: victimPayer, direction: 'request', merchant: merchantA.businessName,
        merchantId: merchantA.id, merchantSCA: merchantA.walletAddress,
        status: 'PENDING',
      },
    });
    // Merchant's own key: the merchant does not control the payer → 403.
    const mRes = await post('/api/payments/settle', { reference: refV }, { 'x-api-key': keyA });
    const mData = await j(mRes);
    ok('merchant-key settle of victim-payer row rejected 403', mRes.status === 403, `got ${mRes.status}: ${JSON.stringify(mData).slice(0, 200)}`);
    ok('merchant-key rejection is the payer-control guard message', typeof mData.error === 'string' && mData.error.includes('payer is a wallet you do not control'), JSON.stringify(mData).slice(0, 200));
    ok('victim row not settled', (await paymentRow(refV))?.status !== 'SUCCESS');
    await prisma.paymentLog.delete({ where: { reference: refV } }).catch(() => { });
    // Internal key on a foreign victim payer: also 403 (the internal key may
    // only ever settle the platform's own agent as payer).
    const vRes = await post('/api/payments/settle', { reference: refV2 }, { 'x-api-key': INTERNAL_KEY });
    const vData = await j(vRes);
    ok('internal-key settle of victim-payer row rejected 403', vRes.status === 403, `got ${vRes.status}: ${JSON.stringify(vData).slice(0, 200)}`);
    const vRow = await paymentRow(refV2);
    ok('victim row not settled and untouched', vRow?.status !== 'SUCCESS' && vRow?.status === 'PENDING', `status ${vRow?.status}`);
    await prisma.paymentLog.delete({ where: { reference: refV2 } }).catch(() => { });

    // (b) "consumer request drain" shape: merchantId null, payer
    // 'pending@checkout', merchantSCA = the requester's OWN wallet (what a
    // consumer direction:'request' initialize produces). The audit's C1
    // exploit chain: the platform default payer used to fund THIS row.
    const drainSCA = `0x${'b'.repeat(40)}`;
    const refDrain = `arc_ref_drain_${Date.now()}`;
    await prisma.paymentLog.create({
      data: {
        reference: refDrain, amount: AMOUNT, currency: 'USDC', chain: 'Arc Testnet v1.0',
        senderEmail: 'pending@checkout', direction: 'request', merchant: 'consumer-request',
        status: 'PENDING', merchantSCA: drainSCA,
      },
    });
    const dRes = await post('/api/payments/settle', { reference: refDrain }, { 'x-api-key': INTERNAL_KEY });
    const dData = await j(dRes);
    ok('internal-key settle of consumer-request drain row rejected 403', dRes.status === 403, `got ${dRes.status}: ${JSON.stringify(dData).slice(0, 200)}`);
    const dRow = await paymentRow(refDrain);
    ok('drain row not settled and untouched', dRow?.status !== 'SUCCESS' && dRow?.status === 'PENDING', `status ${dRow?.status}`);
    await prisma.paymentLog.delete({ where: { reference: refDrain } }).catch(() => { });
  }

  // 11. C2 — cross-tenant agentSCA drain is rejected at initialize.
  console.log('\n[10] initialize agentSCA ownership (C2)');
  const agentToken = `${Date.now()}`;
  const victimAgent = await prisma.agentRegistry.create({
    data: {
      name: 'victim agent', tokenId: `${agentToken}v`, scaAddress: `0x${'c'.repeat(40)}`,
      ownerNode: merchantB.walletAddress, status: 'REGISTERED', merchantId: merchantB.id,
    },
  });
  const controlAgent = await prisma.agentRegistry.create({
    data: {
      name: 'control agent', tokenId: `${agentToken}c`, scaAddress: `0x${'d'.repeat(40)}`,
      ownerNode: merchantA.walletAddress, status: 'REGISTERED', merchantId: merchantA.id,
    },
  });
  try {
    const before = await prisma.paymentLog.count();
    const xInit = await post('/api/payments/initialize', {
      amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
      agentSCA: victimAgent.scaAddress,
    }, { 'x-api-key': keyA });
    const xData = await j(xInit);
    const after = await prisma.paymentLog.count();
    ok('merchant naming ANOTHER tenant\'s agentSCA rejected 403', xInit.status === 403, `got ${xInit.status}: ${JSON.stringify(xData).slice(0, 200)}`);
    ok('no PaymentLog row created for the rejected initialize', after === before, `rows ${before} → ${after}`);
    const okInit = await post('/api/payments/initialize', {
      amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
      agentSCA: controlAgent.scaAddress,
    }, { 'x-api-key': keyA });
    const okData = await j(okInit);
    ok('merchant naming their OWN agentSCA accepted 200', okInit.status === 200, `got ${okInit.status}: ${JSON.stringify(okData).slice(0, 200)}`);
    const okRow = okData.reference ? await paymentRow(okData.reference) : null;
    ok('own-agent row payer = the agent SCA', okRow?.senderEmail?.toLowerCase() === controlAgent.scaAddress.toLowerCase(), okRow?.senderEmail);
    if (okData.reference) await prisma.paymentLog.delete({ where: { reference: okData.reference } }).catch(() => { });
  } finally {
    await prisma.agentRegistry.delete({ where: { id: victimAgent.id } }).catch(() => { });
    await prisma.agentRegistry.delete({ where: { id: controlAgent.id } }).catch(() => { });
  }

  // 12. Unauthorized settlement — merchant B settling merchant A's payment -> 403.
  console.log('\n[11] unauthorized settlement (merchant B key on merchant A payment)');
  const initC = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
  }, { 'x-api-key': keyA });
  const refC = (await j(initC)).reference;
  ok('initialize C 200', initC.status === 200, `got ${initC.status}`);
  const rogue = await post('/api/payments/settle', { reference: refC }, { 'x-api-key': keyB });
  const rogueData = await j(rogue);
  ok('unauthorized settle 403', rogue.status === 403, `got ${rogue.status}: ${JSON.stringify(rogueData).slice(0, 200)}`);
  row = await paymentRow(refC);
  // Guard runs before the lock now: the rejected row is left PENDING.
  ok('row untouched (stays PENDING, no lock flip)', row?.status === 'PENDING', row?.status);
  await prisma.paymentLog.delete({ where: { reference: refC } }).catch(() => { });

  // 12. Concurrent settlement of a legitimate platform-agent row — the
  // brain's agent_pay_agent flow (initialize with agentSCA =
  // AGENT_OWNER_WALLET_ADDRESS via the internal key, then settle). Both
  // callers are authorized (payer = platform agent, internal key), so the
  // atomic lock arbitrates: exactly one settles, the other gets 409. This
  // is also the proof that the fail-closed Path B wallet resolution still
  // funds the platform agent from DEFAULT_PAYER_WALLET_ID (~0.01 USDC).
  console.log('\n[12] concurrent settlement (two simultaneous internal-key settles)');
  const initD = await post('/api/payments/initialize', {
    amount: AMOUNT, currency: 'USDC', direction: 'request', merchant: merchantA.businessName,
    agentSCA: PLATFORM_AGENT,
  }, { 'x-api-key': INTERNAL_KEY });
  const initDData = await j(initD);
  ok('initialize D (platform-agent payer) 200', initD.status === 200, `got ${initD.status}: ${JSON.stringify(initDData).slice(0, 200)}`);
  const refD = initDData.reference;
  ok('initialize D returns reference', !!refD, JSON.stringify(initDData).slice(0, 200));
  const [c1, c2] = await Promise.all([
    post('/api/payments/settle', { reference: refD }, { 'x-api-key': INTERNAL_KEY }),
    post('/api/payments/settle', { reference: refD }, { 'x-api-key': INTERNAL_KEY }),
  ]);
  const codes = [c1.status, c2.status].sort();
  const d1 = await j(c1);
  const d2 = await j(c2);
  console.log(`  responses: ${JSON.stringify([{ s: c1.status, b: d1 }, { s: c2.status, b: d2 }]).slice(0, 400)}`);
  ok('exactly one settles (200), one lock rejection (409)', codes[0] === 200 && codes[1] === 409, `codes ${codes}`);
  const winner = c1.status === 200 ? { s: c1.status, d: d1 } : { s: c2.status, d: d2 };
  const loser = c1.status === 409 ? d1 : d2;
  ok('winner settled with success + arcTxHash', winner.s === 200 && winner.d.success === true && !!winner.d.arcTxHash, JSON.stringify(winner.d).slice(0, 200));
  ok('loser rejected with 409 idempotency message', loser.error === 'Payment already processing or settled.', JSON.stringify(loser).slice(0, 200));
  row = await paymentRow(refD);
  ok('row SUCCESS with arcTxHash + circleTxId', row?.status === 'SUCCESS' && !!row?.arcTxHash && !!row?.circleTxId, JSON.stringify({ status: row?.status, arcTxHash: row?.arcTxHash, circleTxId: row?.circleTxId }));
  ok('payer recorded as the platform agent', row?.senderEmail?.toLowerCase() === PLATFORM_AGENT, row?.senderEmail);
  snapshot('after concurrent settle', row);

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