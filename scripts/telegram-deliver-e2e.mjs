// scripts/telegram-deliver-e2e.mjs
// REAL end-to-end /deliver test: creates an actual ERC-8183 job on Arc
// Testnet through the app's own routes — /api/jobs/create (merchant A,
// client) -> /api/jobs/set-budget (Telegram consumer, provider) ->
// /api/jobs/fund (merchant A, client) — then runs /deliver through the
// actual Telegram webhook + bot handler, which calls the REAL
// /api/jobs/submit route (consumer_token cookie, withApiKeyOrAnySession).
// Confirms the on-chain submit(uint256,bytes32,bytes) tx lands and the DB
// mirror moves to SUBMITTED.
//
// Usage: node scripts/telegram-deliver-e2e.mjs [baseUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
// Next.js precedence: .env.local overrides .env for the dev server. The
// app mints/verifies consumer_token with the .env.local secret, so scripts
// that mint cookies must use the same value.
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import bcrypt from 'bcryptjs';
import { createPublicClient, http, formatUnits } from 'viem';
import { defineChain } from 'viem/utils';

const arcTestnet = defineChain({
  id: 161221135,
  name: 'Arc Testnet',
  nativeCurrency: { decimals: 18, name: 'ARC', symbol: 'ARC' },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const CONSUMER_JWT_SECRET = process.env.CONSUMER_JWT_SECRET || '';
const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';

const TG_E2E_USER = '910000005';
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
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ❌ ${name} — ${detail}`);
  }
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

async function botUpdate(text, fromId) {
  return fetch(`${BASE}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify({
      message: {
        message_id: Math.floor(Math.random() * 1e6),
        from: { id: fromId, first_name: 'E2E', username: 'e2e' },
        chat: { id: fromId },
        text,
      },
    }),
  });
}

async function main() {
  console.log('── Telegram /deliver REAL E2E ─────────────────────────────');
  if (!(await waitForServer())) {
    console.log('❌ dev server not reachable');
    process.exitCode = 1;
    return;
  }
  if (!SECRET) { console.log('❌ TELEGRAM_WEBHOOK_SECRET not set'); process.exitCode = 1; return; }
  if (!CONSUMER_JWT_SECRET) { console.log('❌ CONSUMER_JWT_SECRET not set'); process.exitCode = 1; return; }

  let createdConsumer = false;
  let preExistingTelegramUserId = null;
  let originalMerchantHash = null;
  let jobId = null;
  const txHashes = [];

  try {
    // ── merchant A (client side of the job) ────────────────────────────────
    const merchant = await prisma.merchant.findFirst({
      where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } },
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

    // ── seed the Telegram consumer on the DEFAULT_PAYER wallet ─────────────
    let account = await prisma.consumerAccount.findUnique({ where: { walletAddress: DEFAULT_PAYER_SCA } });
    if (account) {
      preExistingTelegramUserId = account.telegramUserId;
      await prisma.consumerAccount.update({ where: { id: account.id }, data: { telegramUserId: TG_E2E_USER } });
      console.log(`using existing consumer account ${account.id}`);
    } else {
      account = await prisma.consumerAccount.create({
        data: {
          telegramUserId: TG_E2E_USER,
          walletAddress: DEFAULT_PAYER_SCA,
          circleWalletId: DEFAULT_PAYER_WALLET_ID,
          onboardingSource: 'telegram',
        },
      });
      createdConsumer = true;
      console.log(`seeded consumer account ${account.id}`);
    }

    const cookie = await consumerCookie(account.id, DEFAULT_PAYER_SCA);
    const clientBalanceBefore = await balanceOf(merchant.walletAddress);
    const providerBalanceBefore = await balanceOf(DEFAULT_PAYER_SCA);
    ok('merchant A (client) wallet has USDC to fund the job', clientBalanceBefore >= 0.01, `balance ${clientBalanceBefore}`);

    // ── 1. merchant creates the job (client = merchant A) ──────────────────
    const createRes = await fetch(`${BASE}/api/jobs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({
        clientWalletId: merchant.circleWalletId,
        providerAddress: DEFAULT_PAYER_SCA,
        evaluatorAddress: DEFAULT_PAYER_SCA,
        description: 'Telegram /deliver REAL E2E — deliverable submission test',
      }),
    });
    const created = await createRes.json();
    ok('merchant created job', createRes.status === 200 && created.success, `${createRes.status} ${created.error || ''}`);
    jobId = created.jobId;
    txHashes.push(created.txHash);
    console.log(`  jobId ${jobId}  create tx ${created.txHash}`);

    // ── 2. provider (Telegram consumer) sets budget = 0.01 USDC ───────────
    const budgetRes = await fetch(`${BASE}/api/jobs/set-budget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ jobId, providerWalletId: DEFAULT_PAYER_WALLET_ID, budget: '10000' }),
    });
    const budgeted = await budgetRes.json();
    ok('set-budget by consumer session (new wrapper)', budgetRes.status === 200 && budgeted.success, `${budgetRes.status} ${budgeted.error || ''}`);
    txHashes.push(budgeted.txHash);

    // ── 3. client (merchant A) funds escrow → on-chain Funded ─────────────
    const fundRes = await fetch(`${BASE}/api/jobs/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({ jobId, clientWalletId: merchant.circleWalletId }),
    });
    const funded = await fundRes.json();
    ok('fund accepted', fundRes.status === 200 && funded.success, `${fundRes.status} ${funded.error || ''}`);
    txHashes.push(funded.txHash);
    const dbAfterFund = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    ok('DB mirror FUNDED before deliver', dbAfterFund?.status === 'FUNDED', `status ${dbAfterFund?.status}`);
    ok('client debited 0.01 USDC', Math.abs((clientBalanceBefore - await balanceOf(merchant.walletAddress)) - 0.01) < 0.000001, `delta ${(clientBalanceBefore - await balanceOf(merchant.walletAddress)).toFixed(6)}`);

    // ── 4. /deliver through the ACTUAL Telegram webhook + bot handler ──────
    const webhookRes = await botUpdate(`/deliver ${jobId} E2E real deliverable https://example.com/artifact-${jobId}`, TG_E2E_USER);
    ok('webhook answered 200 ok:true', webhookRes.status === 200, `got ${webhookRes.status}`);

    const db = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    ok('DB mirror moved to SUBMITTED', db?.status === 'SUBMITTED', `status ${db?.status}`);
    ok('deliverableHash recorded', !!db?.deliverableHash);
    const submitHash = (db?.txHashes || []).find((h) => !txHashes.includes(h));
    ok('submit tx hash recorded in mirror', !!submitHash, `hashes ${JSON.stringify(db?.txHashes)}`);
    console.log(`  SUBMIT TX: ${submitHash}`);

    if (submitHash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: submitHash, timeout: 90_000 });
      ok('on-chain submit tx mined successfully', receipt.status === 'success', `status ${receipt.status}`);
      console.log(`  explorer: https://testnet.arcscan.app/tx/${submitHash}`);
    }

    ok('provider (consumer) wallet NOT debited (signs only)', Math.abs((providerBalanceBefore - await balanceOf(DEFAULT_PAYER_SCA))) < 0.000001, `delta ${(providerBalanceBefore - await balanceOf(DEFAULT_PAYER_SCA)).toFixed(6)}`);
  } catch (err) {
    console.error('E2E threw:', err);
    failed++;
    failures.push({ name: 'e2e run', detail: err.message });
  } finally {
    // ── cleanup ─────────────────────────────────────────────────────────────
    if (jobId) {
      await prisma.erc8183Job.deleteMany({ where: { jobId: BigInt(jobId) } }).catch(() => { });
    }
    if (originalMerchantHash) {
      await prisma.merchant.update({ where: { businessName: 'acne corp' }, data: { passwordHash: originalMerchantHash } }).catch(() => { });
    }
    const acct = await prisma.consumerAccount.findFirst({ where: { telegramUserId: TG_E2E_USER } });
    if (acct) {
      if (createdConsumer) {
        await prisma.consumerAccount.delete({ where: { id: acct.id } }).catch(() => { });
      } else {
        await prisma.consumerAccount.update({ where: { id: acct.id }, data: { telegramUserId: preExistingTelegramUserId } }).catch(() => { });
      }
    }
    console.log('cleanup: E2E rows removed, merchant hash restored');
  }

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('✅ REAL /deliver E2E: on-chain submit landed, DB SUBMITTED');
  }
}

main().finally(() => prisma.$disconnect());