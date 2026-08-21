// scripts/nanopayment-stream-e2e.mjs
// REAL end-to-end nanopayment stream test on Arc Testnet.
// Tests the full criterion-based nanopayment lifecycle:
//   create job -> set-budget -> fund -> open stream -> release tranches -> close
// Verifies on-chain state, worker balance deltas, idempotency, auth boundaries.

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import bcrypt from 'bcryptjs';
import { createPublicClient, http, formatUnits } from 'viem';
import { defineChain } from 'viem/utils';

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { decimals: 18, name: 'ARC', symbol: 'ARC' },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

const BASE = process.argv[2] || 'http://localhost:3000';
const CONSUMER_JWT_SECRET = process.env.CONSUMER_JWT_SECRET || '';
const USDC = '0x3600000000000000000000000000000000000000';
const RPC = 'https://rpc.testnet.arc.network';

// Use the existing 'acne corp' merchant (client) and DEFAULT_PAYER (worker/evaluator)
const MERCHANT_BUSINESS_NAME = 'acne corp';
const TEST_PASSWORD = 'E2E_Test_123!';
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';

const prisma = new PrismaClient();
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ❌ ${name} — ${detail}`); }
}

async function balanceOf(addr) {
  const raw = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
  return Number(formatUnits(raw, 6));
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

async function consumerCookie(consumerId, walletAddress) {
  const token = await new SignJWT({ consumerId, walletAddress })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(CONSUMER_JWT_SECRET));
  return `consumer_token=${token}`;
}

async function postJson(url, body, cookie) {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { res, data: await res.json().catch(() => ({})) };
}

async function main() {
  console.log('── Nanopayment Stream REAL E2E ───────────────────────────────');
  if (!(await waitForServer())) { console.log('❌ dev server not reachable'); process.exitCode = 1; return; }
  if (!CONSUMER_JWT_SECRET) { console.log('❌ CONSUMER_JWT_SECRET not set'); process.exitCode = 1; return; }

  let createdConsumer = false;
  let preExistingTelegramUserId = null;
  let originalMerchantHash = null;
  let jobId = null;
  let streamId = null;
  const txHashes = [];

  try {
    // ── Merchant A (client) ────────────────────────────────────────────────
    const merchant = await prisma.merchant.findFirst({
      where: { businessName: MERCHANT_BUSINESS_NAME, verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } },
    });
    if (!merchant?.email || !merchant.passwordHash || !merchant.circleWalletId) {
      throw new Error('merchant A not found with email/circleWalletId — needed as job client');
    }
    originalMerchantHash = merchant.passwordHash;
    const testHash = await bcrypt.hash(TEST_PASSWORD, 10);
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: testHash } });

    const loginRes = await fetch(`${BASE}/api/merchant/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: merchant.email, password: TEST_PASSWORD }),
    });
    const loginData = await loginRes.json();
    const merchantCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    ok('merchant A login ok (job client)', loginRes.status === 200 && loginData.success, `got ${loginRes.status}`);

    // ── Seed Telegram consumer on DEFAULT_PAYER wallet (provider + evaluator) ─────────────────
    let account = await prisma.consumerAccount.findUnique({ where: { walletAddress: DEFAULT_PAYER_SCA } });
    if (account) {
      preExistingTelegramUserId = account.telegramUserId;
      await prisma.consumerAccount.update({ where: { id: account.id }, data: { telegramUserId: '910000005' } });
      console.log(`using existing consumer account ${account.id}`);
    } else {
      account = await prisma.consumerAccount.create({
        data: { telegramUserId: '910000005', walletAddress: DEFAULT_PAYER_SCA, circleWalletId: DEFAULT_PAYER_WALLET_ID, onboardingSource: 'telegram' },
      });
      createdConsumer = true;
      console.log(`seeded consumer account ${account.id}`);
    }

    const consumerCookieStr = await consumerCookie(account.id, DEFAULT_PAYER_SCA);
    const clientBalanceBefore = await balanceOf(merchant.walletAddress);
    const workerBalanceBefore = await balanceOf(DEFAULT_PAYER_SCA);
    ok('merchant A (client) wallet has USDC to fund the job', clientBalanceBefore >= 0.02, `balance ${clientBalanceBefore}`);

    // ── 1. Create job (client = merchant A) ────────────────────────────────
    const createRes = await fetch(`${BASE}/api/jobs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({
        clientWalletId: merchant.circleWalletId,
        providerAddress: DEFAULT_PAYER_SCA,
        evaluatorAddress: DEFAULT_PAYER_SCA,
        description: 'Nanopayment stream E2E — criterion-based payments',
      }),
    });
    const created = await createRes.json();
    ok('merchant created job', createRes.status === 200 && created.success, `${createRes.status} ${created.error || ''}`);
    jobId = created.jobId;
    txHashes.push(created.txHash);
    console.log(`  jobId ${jobId}  create tx ${created.txHash}`);

    // ── 2. Provider (consumer) sets budget = 0.03 USDC (30000 base units) ───────────
    const BUDGET = '30000'; // 0.03 USDC in 6-dec units
    const budgetRes = await fetch(`${BASE}/api/jobs/set-budget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: consumerCookieStr },
      body: JSON.stringify({ jobId, providerWalletId: DEFAULT_PAYER_WALLET_ID, budget: BUDGET }),
    });
    const budgeted = await budgetRes.json();
    ok('set-budget by consumer session', budgetRes.status === 200 && budgeted.success, `${budgetRes.status} ${budgeted.error || ''}`);
    txHashes.push(budgeted.txHash);

    // ── 3. Client (merchant A) funds escrow ─────────────────────────────────
    const fundRes = await fetch(`${BASE}/api/jobs/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({ jobId, clientWalletId: merchant.circleWalletId }),
    });
    const funded = await fundRes.json();
    ok('fund accepted', fundRes.status === 200 && funded.success, `${fundRes.status} ${funded.error || ''}`);
    txHashes.push(funded.txHash);
    const dbAfterFund = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    ok('DB mirror FUNDED before stream', dbAfterFund?.status === 'FUNDED', `status ${dbAfterFund?.status}`);
    ok('client debited 0.03 USDC', Math.abs((clientBalanceBefore - await balanceOf(merchant.walletAddress)) - 0.03) < 0.000001, `delta ${(clientBalanceBefore - await balanceOf(merchant.walletAddress)).toFixed(6)}`);

    // ── 4. Open nanopayment stream (3 criteria) ─────────────────────────────
    const criteria = {
      jobId,
      description: 'Nanopayment stream E2E',
      requirements: [
        'Complete backend API implementation',
        'Write unit tests for all endpoints',
        'Deploy to staging and verify',
      ],
      deadlineUnix: Math.floor(Date.now() / 1000) + 86400,
    };
    const openRes = await postJson('/api/jobs/nanopay/open', { jobId, criteria }, merchantCookie);
    ok('open stream accepted', openRes.res.status === 200 && openRes.data.success, `${openRes.res.status} ${openRes.data.error || ''}`);
    ok('open returns streamId', !!openRes.data.streamId, '');
    ok('open returns 3 tranche amounts', openRes.data.trancheAmounts?.length === 3, `got ${openRes.data.trancheAmounts?.length}`);
    ok('tranche amounts sum to budget', openRes.data.trancheAmounts?.reduce((a, b) => BigInt(a) + BigInt(b), 0n) === BigInt(BUDGET), `sum=${openRes.data.trancheAmounts?.reduce((a, b) => BigInt(a) + BigInt(b), 0n)}`);
    streamId = openRes.data.streamId;
    txHashes.push(openRes.data.txHash);

    // Verify on-chain stream state
const streamAbi = [
    {
      name: 'getStream',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'streamId', type: 'uint256' }],
      outputs: [
        { name: 'poster', type: 'address' },
        { name: 'worker', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'totalBudget', type: 'uint256' },
        { name: 'trancheCount', type: 'uint256' },
        { name: 'tranchesReleased', type: 'uint256' },
        { name: 'totalReleased', type: 'uint256' },
        { name: 'closed', type: 'bool' },
        { name: 'openedAt', type: 'uint64' },
      ],
    },
  ];
    const streamContract = process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS;
    const onChainStream = await publicClient.readContract({
      address: streamContract,
      abi: streamAbi,
      functionName: 'getStream',
      args: [BigInt(streamId)],
    });
    ok('on-chain stream poster = client', onChainStream[0].toLowerCase() === merchant.walletAddress.toLowerCase(), `got ${onChainStream[0]}`);
    ok('on-chain stream worker = provider', onChainStream[1].toLowerCase() === DEFAULT_PAYER_SCA.toLowerCase(), `got ${onChainStream[1]}`);
    ok('on-chain stream token = USDC', onChainStream[2].toLowerCase() === USDC.toLowerCase(), `got ${onChainStream[2]}`);
    ok('on-chain budget = 30000', onChainStream[3] === 30000n, `got ${onChainStream[3]}`);
    ok('on-chain trancheCount = 3', onChainStream[4] === 3n, `got ${onChainStream[4]}`);
    ok('on-chain tranchesReleased = 0', onChainStream[5] === 0n, `got ${onChainStream[5]}`);
    ok('stream not closed on-chain', onChainStream[7] === false, `got ${onChainStream[7]}`);

    // ── 5. Release criterion 0 (backend API) ────────────────────────────────
    const workerBefore0 = await balanceOf(DEFAULT_PAYER_SCA);
    const rel0 = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 0 }, merchantCookie);
    ok('release 0 accepted', rel0.res.status === 200 && rel0.data.success, `${rel0.res.status} ${rel0.data.error || ''}`);
    ok('release 0 returns txHash', !!rel0.data.txHash, '');
    txHashes.push(rel0.data.txHash);

    // Same-block worker balance delta
    const workerAfter0 = await balanceOf(DEFAULT_PAYER_SCA);
    const delta0 = workerAfter0 - workerBefore0;
    ok('worker received tranche 0', delta0 > 0.009 && delta0 < 0.011, `delta ${delta0.toFixed(6)} (expected ~0.01 minus fee)`);

    // Verify on-chain releasedTranches
    const releasedAbi = [
      {
        name: 'releasedTranches',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'streamId', type: 'uint256' }, { name: 'index', type: 'uint256' }],
        outputs: [{ name: '', type: 'bool' }],
      },
    ];
    const rel0OnChain = await publicClient.readContract({ address: streamContract, abi: releasedAbi, functionName: 'releasedTranches', args: [BigInt(streamId), 0n] });
    ok('on-chain releasedTranches[0] = true', rel0OnChain === true, `got ${rel0OnChain}`);

    // ── 6. Idempotent replay of criterion 0 ─────────────────────────────────
    const rel0again = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 0 }, merchantCookie);
    ok('replay of criterion 0 returns same txHash', rel0again.res.status === 200 && rel0again.data.replayed === true && rel0again.data.txHash === rel0.data.txHash, `replayed=${rel0again.data.replayed}, hash=${rel0again.data.txHash}`);
    const workerAfterReplay = await balanceOf(DEFAULT_PAYER_SCA);
    ok('replay did not double-pay', Math.abs(workerAfterReplay - workerAfter0) < 0.000001, `delta ${(workerAfterReplay - workerAfter0).toFixed(6)}`);

    // ── 7. Release criterion 1 (unit tests) ─────────────────────────────────
    const workerBefore1 = await balanceOf(DEFAULT_PAYER_SCA);
    const rel1 = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 1 }, consumerCookieStr); // evaluator can also trigger
    ok('release 1 by evaluator accepted', rel1.res.status === 200 && rel1.data.success, `${rel1.res.status} ${rel1.data.error || ''}`);
    txHashes.push(rel1.data.txHash);
    const workerAfter1 = await balanceOf(DEFAULT_PAYER_SCA);
    const delta1 = workerAfter1 - workerBefore1;
    ok('worker received tranche 1', delta1 > 0.009 && delta1 < 0.011, `delta ${delta1.toFixed(6)}`);

    // ── 8. Release final criterion 2 (deploy + remainder) ───────────────────
    const workerBefore2 = await balanceOf(DEFAULT_PAYER_SCA);
    const rel2 = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 2 }, merchantCookie);
    ok('release 2 accepted', rel2.res.status === 200 && rel2.data.success, `${rel2.res.status} ${rel2.data.error || ''}`);
    txHashes.push(rel2.data.txHash);
    const workerAfter2 = await balanceOf(DEFAULT_PAYER_SCA);
    const delta2 = workerAfter2 - workerBefore2;
    ok('worker received tranche 2 (incl remainder)', delta2 > 0.009 && delta2 < 0.011, `delta ${delta2.toFixed(6)}`);

    // Verify total on-chain released
    const totalReleasedAbi = [
      {
        name: 'getStream',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'streamId', type: 'uint256' }],
        outputs: [
          { name: 'poster', type: 'address' },
          { name: 'worker', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'totalBudget', type: 'uint256' },
          { name: 'trancheCount', type: 'uint256' },
          { name: 'tranchesReleased', type: 'uint256' },
          { name: 'totalReleased', type: 'uint256' },
          { name: 'closed', type: 'bool' },
          { name: 'openedAt', type: 'uint64' },
        ],
      },
    ];
    const finalStream = await publicClient.readContract({ address: streamContract, abi: totalReleasedAbi, functionName: 'getStream', args: [BigInt(streamId)] });
    ok('on-chain totalReleased == budget', finalStream[6] === 30000n, `got ${finalStream[6]}`);

    // ── 9. Close stream (should release nothing extra since all tranches done) ─────
    const closeRes = await postJson('/api/jobs/nanopay/close', { jobId }, merchantCookie);
    ok('close accepted', closeRes.res.status === 200 && closeRes.data.success, `${closeRes.res.status} ${closeRes.data.error || ''}`);
    ok('close returns closedAt', !!closeRes.data.closedAt, '');
    txHashes.push(closeRes.data.txHash);

    // Verify on-chain closed
    const closedStream = await publicClient.readContract({ address: streamContract, abi: totalReleasedAbi, functionName: 'getStream', args: [BigInt(streamId)] });
    ok('on-chain stream closed', closedStream[7] === true, `got ${closedStream[7]}`);
    ok('on-chain totalReleased still == budget after close', closedStream[6] === 30000n, `got ${closedStream[6]}`);

    // ── 10. Unauthorized release attempt (no auth cookie) ──────────────────────
    const unauth = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 0 }, '');
    ok('unauthorized release rejected', unauth.res.status === 401, `got ${unauth.res.status}`);

    // ── 11. Malformed requirement index ───────────────────────────────────────
    const badIdx = await postJson('/api/jobs/nanopay/release', { jobId, requirementIndex: 99 }, merchantCookie);
    ok('out-of-range index rejected', badIdx.res.status === 400, `got ${badIdx.res.status}`);

    // ── 12. Status endpoint ───────────────────────────────────────────────────
    const statusRes = await postJson('/api/jobs/nanopay/status', { jobId }, merchantCookie);
    ok('status endpoint works', statusRes.res.status === 200 && statusRes.data.success, `${statusRes.res.status}`);
    ok('status includes on-chain releasedIndexes', statusRes.data.status?.onChain?.releasedIndexes?.length === 3, `got ${statusRes.data.status?.onChain?.releasedIndexes?.length}`);
    ok('status on-chain closed = true', statusRes.data.status?.onChain?.closed === true, `got ${statusRes.data.status?.onChain?.closed}`);

    // ── 13. Total worker payment equals budget minus measured fees ────────────
    const totalWorkerGain = await balanceOf(DEFAULT_PAYER_SCA) - workerBalanceBefore;
    ok('total worker gain == budget (no fees on this contract)', totalWorkerGain >= 0.0299 && totalWorkerGain <= 0.0301, `gain ${totalWorkerGain.toFixed(6)} (budget 0.03)`);

  } catch (err) {
    console.error('E2E threw:', err);
    failed++;
    failures.push({ name: 'e2e run', detail: err.message });
  } finally {
    // Cleanup
    if (jobId) {
      await prisma.jobNanopaymentTranche.deleteMany({ where: { jobId: jobId.toString() } }).catch(() => {});
      await prisma.jobNanopaymentStream.deleteMany({ where: { jobId: jobId.toString() } }).catch(() => {});
      await prisma.erc8183Job.deleteMany({ where: { jobId: BigInt(jobId) } }).catch(() => {});
    }
    if (originalMerchantHash) {
      await prisma.merchant.update({ where: { businessName: MERCHANT_BUSINESS_NAME }, data: { passwordHash: originalMerchantHash } }).catch(() => {});
    }
    const acct = await prisma.consumerAccount.findFirst({ where: { telegramUserId: '910000005' } });
    if (acct) {
      if (createdConsumer) await prisma.consumerAccount.delete({ where: { id: acct.id } }).catch(() => {});
      else await prisma.consumerAccount.update({ where: { id: acct.id }, data: { telegramUserId: preExistingTelegramUserId } }).catch(() => {});
    }
    console.log('cleanup: E2E rows removed, merchant hash restored');
  }

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('✅ Nanopayment Stream E2E: all criterion-based tranches verified on-chain');
  }
}

main().finally(() => prisma.$disconnect());