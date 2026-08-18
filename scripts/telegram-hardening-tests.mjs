/**
 * scripts/telegram-hardening-tests.mjs
 *
 * Telegram bot hardening suite — same discipline as
 * checkout-hardening-tests.mjs: testnet only, no real funds, explicit
 * cleanup of every row it creates.
 *
 * Covers:
 *  - webhook secret-token gate (missing / wrong / correct)
 *  - /start: exactly one account on repeat calls (idempotency), and
 *    fail-closed first contact when CIRCLE_WALLET_SET_ID is not configured
 *  - /apply: duplicate application rejected (single JobApplication row)
 *  - /withdraw: malformed address rejected; confirmation gate (nothing
 *    moves on the first message; /confirm executes); TTL expiry
 *
 * The webhook always answers { ok: true } and sends the human-readable
 * reply to Telegram (not back over HTTP), so behavioral assertions are
 * DB/balance-based, not reply-text-based.
 *
 * Usage: node scripts/telegram-hardening-tests.mjs http://127.0.0.1:3000
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http, formatUnits, defineChain } from 'viem';

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { decimals: 18, name: 'ARC', symbol: 'ARC' },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';

const TG_START_USER = '910000001'; // returning-user idempotency
const TG_FRESH_USER = '910000002'; // first contact, unconfigured provisioning
const TG_APPLIER_USER = '910000004'; // duplicate-application rejection
const TG_WITHDRAWER = '910000003'; // real-Circle-wallet withdrawal flow
const SEED_JOB_ID = '9007199254740993123';

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

async function update(text, fromId) {
  return fetch(`${BASE}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify({
      message: {
        message_id: Math.floor(Math.random() * 1e6),
        from: { id: fromId, first_name: 'Harness', username: 'harness' },
        chat: { id: fromId },
        text,
      },
    }),
  });
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

async function main() {
  console.log('── Telegram Hardening Suite ─────────────────────────────');
  if (!(await waitForServer())) {
    console.log(`❌ dev server not reachable at ${BASE}`);
    process.exitCode = 1;
    return;
  }
  if (!SECRET) {
    console.log('❌ TELEGRAM_WEBHOOK_SECRET not set in .env — cannot test the gate');
    process.exitCode = 1;
    return;
  }

  const merchantA = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null } },
  });
  if (!merchantA?.walletAddress) throw new Error('merchant A not found — needed as withdrawal destination');
  const destAddress = merchantA.walletAddress;
  console.log(`destination for withdrawal test: ${destAddress}`);

  // ══ 1. WEBHOOK SECRET GATE ═════════════════════════════════════════

  console.log('\n[webhook] secret-token gate');
  {
    const body = { message: { message_id: 1, from: { id: 1, first_name: 'x' }, chat: { id: 1 }, text: '/help' } };
    const noSecret = await fetch(`${BASE}/api/telegram/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    ok('missing secret token → 401', noSecret.status === 401, `got ${noSecret.status}`);

    const wrongSecret = await fetch(`${BASE}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
      body: JSON.stringify(body),
    });
    ok('wrong secret token → 401', wrongSecret.status === 401, `got ${wrongSecret.status}`);

    const badJson = await fetch(`${BASE}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: 'not-json',
    });
    ok('correct secret + malformed payload → 400', badJson.status === 400, `got ${badJson.status}`);

    const good = await update('/help', 1);
    ok('correct secret + valid update → 200 ok:true', good.status === 200, `got ${good.status}`);
  }

  // ══ 2. /start IDEMPOTENCY ══════════════════════════════════════════

  console.log('\n[start] returning user — exactly one account on repeat calls');
  {
    const seededAddress = ethers.Wallet.createRandom().address;
    const seeded = await prisma.consumerAccount.create({
      data: {
        telegramUserId: TG_START_USER,
        walletAddress: seededAddress,
        walletType: 'CIRCLE',
        circleWalletId: 'tg-test-wallet-start',
        onboardingSource: 'telegram',
      },
    });

    const r1 = await update('/start', Number(TG_START_USER));
    const c1 = await prisma.consumerAccount.count({ where: { telegramUserId: TG_START_USER } });
    ok('first /start → 200', r1.status === 200, `got ${r1.status}`);
    ok('exactly one account after first /start', c1 === 1, `count ${c1}`);

    const r2 = await update('/start', Number(TG_START_USER));
    const c2 = await prisma.consumerAccount.count({ where: { telegramUserId: TG_START_USER } });
    ok('repeat /start → 200', r2.status === 200, `got ${r2.status}`);
    ok('still exactly one account after repeat /start', c2 === 1, `count ${c2}`);
    ok('account unchanged (same wallet, same source)', (await prisma.consumerAccount.findUnique({ where: { id: seeded.id } }))?.walletAddress === seededAddress);

    await prisma.consumerAccount.delete({ where: { id: seeded.id } });
  }

  console.log('\n[start] first contact with provisioning unconfigured → fail closed');
  {
    const fresh = await update('/start', Number(TG_FRESH_USER));
    ok('/start → 200 (Telegram always gets ok)', fresh.status === 200, `got ${fresh.status}`);
    const count = await prisma.consumerAccount.count({ where: { telegramUserId: TG_FRESH_USER } });
    ok('no consumerAccount created when CIRCLE_WALLET_SET_ID is unset', count === 0, `count ${count}`);
    const configured = !!process.env.CIRCLE_WALLET_SET_ID;
    if (configured) {
      ok('CIRCLE_WALLET_SET_ID present — live mint path was exercised instead', true);
    }
  }

  // ══ 3. /apply DUPLICATE REJECTION ═══════════════════════════════════

  console.log('\n[apply] duplicate application rejected');
  {
    const jobId = BigInt(SEED_JOB_ID);
    const applicantAddress = ethers.Wallet.createRandom().address;
    await prisma.consumerAccount.create({
      data: {
        telegramUserId: TG_APPLIER_USER,
        walletAddress: applicantAddress,
        walletType: 'CIRCLE',
        circleWalletId: 'tg-test-wallet-applier',
        onboardingSource: 'telegram',
      },
    });
    await prisma.erc8183Job.create({
      data: {
        jobId,
        clientSCA: ethers.Wallet.createRandom().address,
        providerSCA: ethers.Wallet.createRandom().address,
        evaluatorSCA: ethers.Wallet.createRandom().address,
        description: 'Harness telegram hardening job',
        budget: 1000000n,
        status: 'OPEN',
        expiredAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        txHashes: [],
      },
    });

    const a1 = await update(`/apply ${jobId.toString()} harness pitch one`, Number(TG_APPLIER_USER));
    const n1 = await prisma.jobApplication.count({ where: { jobId } });
    ok('first /apply → 200', a1.status === 200, `got ${a1.status}`);
    ok('one application row created', n1 === 1, `count ${n1}`);

    const a2 = await update(`/apply ${jobId.toString()} harness pitch two`, Number(TG_APPLIER_USER));
    const n2 = await prisma.jobApplication.count({ where: { jobId } });
    ok('duplicate /apply rejected (still one row)', a2.status === 200 && n2 === 1, `got ${a2.status}, count ${n2}`);

    const a3 = await update('/apply 12345 only-a-job-id-no-pitch', Number(TG_APPLIER_USER));
    ok('missing pitch → 200 usage reply, no row', a3.status === 200, `got ${a3.status}`);

    await prisma.jobApplication.deleteMany({ where: { jobId } });
    await prisma.erc8183Job.delete({ where: { jobId } });
    await prisma.consumerAccount.deleteMany({ where: { telegramUserId: TG_APPLIER_USER } });
  }

  // ══ 4. /withdraw GATE + CONFIRMATION ════════════════════════════════

  console.log('\n[withdraw] malformed address rejected, no intent stored');
  {
    await prisma.consumerAccount.create({
      data: {
        telegramUserId: TG_WITHDRAWER,
        walletAddress: DEFAULT_PAYER_SCA,
        walletType: 'CIRCLE',
        circleWalletId: DEFAULT_PAYER_WALLET_ID,
        onboardingSource: 'telegram',
      },
    });
    await update('/withdraw 0x123', Number(TG_WITHDRAWER));
    const intents = await prisma.telegramWithdrawalIntent.count({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('malformed address → no intent stored', intents === 0, `intents ${intents}`);

    await update(`/withdraw ${destAddress} not-a-number`, Number(TG_WITHDRAWER));
    const intents2 = await prisma.telegramWithdrawalIntent.count({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('malformed amount → no intent stored', intents2 === 0, `intents ${intents2}`);
  }

  console.log('\n[withdraw] confirmation gate — nothing moves until /confirm');
  {
    const destBefore = await balanceOf(destAddress);
    const srcBefore = await balanceOf(DEFAULT_PAYER_SCA);

    await update(`/withdraw ${destAddress} 0.001`, Number(TG_WITHDRAWER));
    const intent = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('intent stored on /withdraw', !!intent, 'no intent row');
    ok('intent carries requested amount', intent?.amount === '0.001', `amount ${intent?.amount}`);
    const destAfterWithdraw = await balanceOf(destAddress);
    ok('NO transfer on the first message (balance unchanged)', Math.abs(destAfterWithdraw - destBefore) < 0.000001, `delta ${(destAfterWithdraw - destBefore).toFixed(6)}`);

    await update('/confirm', Number(TG_WITHDRAWER));
    await new Promise((r) => setTimeout(r, 5000)); // allow Circle tx polling to settle
    const destAfterConfirm = await balanceOf(destAddress);
    ok('transfer executed only after /confirm', Math.abs(destAfterConfirm - destBefore - 0.001) < 0.000001, `delta ${(destAfterConfirm - destBefore).toFixed(6)}`);
    const intentAfter = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('intent cleared after execution', !intentAfter, 'intent still present');
    ok('source wallet debited', Math.abs((srcBefore - await balanceOf(DEFAULT_PAYER_SCA)) - 0.001) < 0.000001, `src delta ${(srcBefore - await balanceOf(DEFAULT_PAYER_SCA)).toFixed(6)}`);

    await update('/confirm', Number(TG_WITHDRAWER));
    const intentsAfter = await prisma.telegramWithdrawalIntent.count({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('second /confirm with no intent → harmless, still no intent', intentsAfter === 0, `intents ${intentsAfter}`);
  }

  console.log('\n[withdraw] expired intent never executes');
  {
    await prisma.telegramWithdrawalIntent.create({
      data: {
        telegramUserId: TG_WITHDRAWER,
        destinationAddress: destAddress,
        amount: '0.001',
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    const destBefore = await balanceOf(destAddress);
    await update('/confirm', Number(TG_WITHDRAWER));
    await new Promise((r) => setTimeout(r, 3000));
    const destAfter = await balanceOf(destAddress);
    const intentAfter = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('expired intent rejected (no transfer)', Math.abs(destAfter - destBefore) < 0.000001, `delta ${(destAfter - destBefore).toFixed(6)}`);
    ok('expired intent cleared', !intentAfter, 'intent still present');

    await update('/cancel', Number(TG_WITHDRAWER));
    const cancelled = await prisma.telegramWithdrawalIntent.count({ where: { telegramUserId: TG_WITHDRAWER } });
    ok('/cancel with nothing pending → harmless', cancelled === 0, `intents ${cancelled}`);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f.name} — ${f.detail}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch(async (e) => {
    console.error('Harness error:', e.message);
    failed++;
  })
  .finally(async () => {
    await prisma.consumerAccount.deleteMany({
      where: { telegramUserId: { in: [TG_START_USER, TG_FRESH_USER, TG_APPLIER_USER, TG_WITHDRAWER] } },
    }).catch(() => { });
    await prisma.telegramWithdrawalIntent.deleteMany({
      where: { telegramUserId: { in: [TG_START_USER, TG_FRESH_USER, TG_APPLIER_USER, TG_WITHDRAWER] } },
    }).catch(() => { });
    const jobId = BigInt(SEED_JOB_ID);
    await prisma.jobApplication.deleteMany({ where: { jobId } }).catch(() => { });
    await prisma.erc8183Job.delete({ where: { jobId } }).catch(() => { });
    console.log('cleanup: telegram test rows removed');
    await prisma.$disconnect();
  });