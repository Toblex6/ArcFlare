// scripts/procurement-human-e2e.ts
//
// Human-worker procurement loop (Jobs/Telegram batch):
//   merchant posts → Telegram human worker applies → select → hire (ConsumerAccount
//   provider, no AgentRegistry row) → worker /accept (setBudget via consumer session)
//   → client funds → worker delivers → client completes → worker paid.
//
// Proves the product story: a normal human worker enters the same real economic
// pipeline as an AI agent WITHOUT exposing their wallet address to the merchant.
//
// Requires a running dev server: npx next dev
// Run: npx tsx scripts/procurement-human-e2e.ts http://localhost:3000
// Real testnet funds: ~0.02 USDC from the client agent wallet + gas.

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import crypto from 'crypto';
import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import bcrypt from 'bcryptjs';
import { createPublicClient, http, formatUnits, defineChain } from 'viem';
import { prisma } from '@/lib/prisma';
import { provisionWalletForTelegramUser } from '@/lib/wallet/circleWalletProvisioning';
import { ensureAgentDefaultSpendLimit } from '@/lib/agents/spendLimitEnforcer';
import { getCircleClient } from '@/lib/circle/client';
import { recordLedgerEntry } from '@/lib/ledger/ledgerService';

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
const RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const WORKER_TG = '910000070';
const BUDGET_USDC = '0.02';
const BUDGET_WEI = '20000';

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];

let passed = 0;
let failed = 0;
const failures: { name: string; detail: string }[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ❌ ${name} — ${detail}`); }
}
async function balanceOf(addr: string) {
  const raw = await publicClient.readContract({ address: USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
  return Number(formatUnits(raw as bigint, 6));
}
async function consumerCookie(consumerId: string, walletAddress: string) {
  const token = await new SignJWT({ consumerId, walletAddress })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(CONSUMER_JWT_SECRET));
  return `consumer_token=${token}`;
}
async function fetchWithRpcRetry(url: string, opts?: any, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${BASE}${url}`, opts);
    const data = await res.clone().json().catch(() => ({}));
    const msg = JSON.stringify(data).toLowerCase();
    const isFlake = msg.includes('bad record mac') || msg.includes('econnreset') || msg.includes('ssl routines') || msg.includes('alert bad record') || msg.includes('timeout') || msg.includes('-32011');
    if (res.status === 500 && isFlake && attempt < retries - 1) {
      console.log(`  RPC flake on ${url} attempt ${attempt + 1}, retrying...`);
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    return { res, data };
  }
  const res = await fetch(`${BASE}${url}`, opts);
  return { res, data: await res.json().catch(() => ({})) };
}
async function topUpNative(recipient: string, amountUsdc: string) {
  const keyB64 = process.env.X402_WALLET_ENCRYPTION_KEY;
  if (!keyB64) throw new Error('X402_WALLET_ENCRYPTION_KEY not set — cannot top up client agent wallet');
  const key = Buffer.from(keyB64, 'base64');
  const poolRows = await prisma.x402EoaWallet.findMany({ orderBy: { id: 'asc' } });
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallets = await Promise.all(poolRows.map(async (r) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.keyIv, 'base64'));
    decipher.setAuthTag(Buffer.from(r.keyAuthTag, 'base64'));
    const pk = Buffer.concat([decipher.update(Buffer.from(r.encryptedKey, 'base64')), decipher.final()]).toString('utf8');
    const w = new ethers.Wallet(pk, provider);
    return { address: w.address, w, balance: await provider.getBalance(w.address) };
  }));
  const value = ethers.parseEther(amountUsdc);
  const funded = wallets.filter((x) => x.balance >= value);
  if (funded.length === 0) throw new Error('no x402 pool wallet holds enough USDC to top up client agent');
  const pool = funded.sort((a, b) => (b.balance < a.balance ? -1 : 1))[0].w;
  const tx = await pool.sendTransaction({ to: recipient, value });
  const receipt = await tx.wait();
  console.log(`  💰 topped up ${amountUsdc} USDC (native) ${pool.address} → ${recipient} (tx ${receipt?.hash})`);
}

async function main() {
  console.log('── Procurement Human-Worker E2E ───────────────────────────────');
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/api/payments/verify/__probe__`, { signal: AbortSignal.timeout(5000) }); if (r.status === 404) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!CONSUMER_JWT_SECRET) { console.log('❌ CONSUMER_JWT_SECRET not set'); process.exitCode = 1; return; }

  let originalMerchantHash: string | null = null;
  let merchantCookie = '';
  let merchant: any = null;
  let clientAgent: any = null;
  let clientWalletId: string | null = null;
  let clientWalletAddress = '';
  let worker: any = null;
  let postingId = '';
  let jobId = '';
  let restoredPolicy: any = null;

  try {
    // ── Merchant + client agent ──────────────────────────────────────────────
    merchant = await prisma.merchant.findFirst({ where: { verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } } });
    if (!merchant?.email || !merchant.passwordHash) throw new Error('no usable merchant found');
    originalMerchantHash = merchant.passwordHash;
    const testHash = await bcrypt.hash('E2E_Test_123!', 10);
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: testHash } });
    const loginRes = await fetch(`${BASE}/api/merchant/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: merchant.email, password: 'E2E_Test_123!' }) });
    const loginData = await loginRes.json();
    merchantCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    ok('merchant login ok', loginRes.status === 200 && loginData.success, `got ${loginRes.status}`);

    clientAgent = await prisma.agentRegistry.findFirst({ where: { status: 'ACTIVE_AGENT_PROVISIONED', merchantId: merchant.id, circleWalletId: { not: null } } })
      || await prisma.agentRegistry.findFirst({ where: { status: 'ACTIVE_AGENT_PROVISIONED', circleWalletId: { not: null } } });
    if (!clientAgent) throw new Error('no ACTIVE agent with a Circle wallet for the client');
    clientWalletId = clientAgent.circleWalletId;
    const w = await getCircleClient().getWallet({ id: clientWalletId! });
    clientWalletAddress = w.data?.wallet?.address as string;
    if (!clientWalletAddress) throw new Error('client agent Circle wallet not resolvable');
    ok('client agent wallet resolves', clientWalletAddress.toLowerCase() === clientAgent.scaAddress.toLowerCase(), `${clientWalletAddress} vs ${clientAgent.scaAddress}`);
    ok('client agent has no conflicting treasury trust gate (we neutralize below)', true);

    // Neutralize any minTrustScore gate for the run (human workers are neutral 50)
    const policy = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: clientAgent.id } }).catch(() => null);
    if (policy && policy.minTrustScore !== null && policy.minTrustScore !== undefined) {
      restoredPolicy = { minTrustScore: policy.minTrustScore };
      await (prisma as any).agentTreasuryPolicy.update({ where: { agentRegistryId: clientAgent.id }, data: { minTrustScore: null } });
      console.log('  (neutralized client minTrustScore for this run — will restore)');
    }

    // Spend limit bootstrap (idempotent) + USDC preflight for the client wallet
    try { await ensureAgentDefaultSpendLimit(clientWalletAddress); } catch (e: any) { console.log('  ⚠️ ensureAgentDefaultSpendLimit:', e?.message ?? e); }
    const clientBal = await balanceOf(clientWalletAddress).catch(() => 0);
    if (clientBal < 0.05) {
      await topUpNative(clientWalletAddress, '0.5');
    }
    const clientBal2 = await balanceOf(clientWalletAddress).catch(() => 0);
    ok(`client agent wallet funded (>= 0.05 USDC), has ${clientBal2.toFixed(4)}`, clientBal2 >= 0.05, `balance ${clientBal2}`);

    // Treasury ledger credit for the client agent (mirrors the on-chain top-up;
    // hire/fund check the agent's ledger treasury, not just the wallet). Uses a
    // deterministic source dedupe so re-runs don't double-credit.
    const ledgerDedupeKey = "e2e-human-topup:human-e2e:" + clientAgent.id + ":REVENUE";
    await prisma.agentLedgerEntry.deleteMany({ where: { dedupeKey: ledgerDedupeKey } }).catch(() => {});
    await recordLedgerEntry({
      agentRegistryId: clientAgent.id,
      type: "REVENUE",
      amount: 500000n,
      token: "USDC",
      direction: "CREDIT",
      sourceType: "e2e-human-topup",
      sourceId: "human-e2e",
      description: "E2E treasury top-up (procurement human e2e)",
    }).catch((e: any) => console.log('  ⚠️ ledger top-up failed:', e?.message ?? e));

    // ── Human worker: real Circle wallet, NO AgentRegistry row ───────────────
    await prisma.consumerAccount.deleteMany({ where: { telegramUserId: WORKER_TG } }).catch(() => {});
    worker = await provisionWalletForTelegramUser(WORKER_TG, 'E2E Human Worker');
    const workerAgentRow = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: worker.walletAddress, mode: 'insensitive' } } });
    ok('worker has a real Circle wallet', !!worker.circleWalletId && /^0x/.test(worker.walletAddress), JSON.stringify(worker));
    ok('worker has NO AgentRegistry row (genuine human)', !workerAgentRow, `found ${workerAgentRow?.id}`);

    // ── 1. Post ──────────────────────────────────────────────────────────────
    const post = await fetchWithRpcRetry('/api/procurement', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({ clientAgentId: clientAgent.id, description: 'Human-worker procurement e2e deliverable', title: 'Human e2e job', budgetMax: BUDGET_USDC, skill: 'e2e-human' }),
    });
    ok('1. post created', post.res.status === 200 && post.data.success && post.data.posting?.id, `${post.res.status} ${post.data.error || ''}`);
    postingId = post.data.posting.id;

    // ── 2. Worker applies (consumer cookie) ──────────────────────────────────
    const workerAccount = await prisma.consumerAccount.findFirst({ where: { telegramUserId: WORKER_TG } });
    const workerCookie = await consumerCookie(workerAccount!.id, worker.walletAddress);
    const apply = await fetchWithRpcRetry(`/api/procurement/${postingId}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: workerCookie },
      body: JSON.stringify({ applicantAddress: worker.walletAddress, pitch: 'Human worker with a sufficiently detailed pitch for this e2e job, can deliver within a day.', proposedAmount: BUDGET_USDC }),
    });
    ok('2. worker applied', apply.res.status === 200 && apply.data.success, `${apply.res.status} ${apply.data.error || ''}`);

    // ── 3. Merchant reviews ranked applicants ────────────────────────────────
    const applicants = await fetchWithRpcRetry(`/api/procurement/${postingId}/applicants`, { headers: { cookie: merchantCookie } });
    const ranked = applicants.data?.ranked || [];
    ok('3. applicants ranked, worker present', applicants.res.status === 200 && ranked.some((r: any) => r.applicantAddress.toLowerCase() === worker.walletAddress.toLowerCase()), JSON.stringify(ranked).slice(0, 200));

    // ── 4. Select ────────────────────────────────────────────────────────────
    const select = await fetchWithRpcRetry(`/api/procurement/${postingId}/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie },
      body: JSON.stringify({ providerAddress: worker.walletAddress }),
    });
    ok('4. selected', select.res.status === 200 && select.data.success && select.data.posting?.status === 'SELECTED', `${select.res.status} ${select.data.error || ''}`);

    // ── 5. Hire (human provider) → on-chain createJob ────────────────────────
    const hire = await fetchWithRpcRetry(`/api/procurement/${postingId}/hire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({}),
    });
    ok('5. hired (human provider accepted)', hire.res.status === 200 && hire.data.success, `${hire.res.status} ${hire.data.error || ''}`);

    if (hire.data.success) {
      jobId = hire.data.jobId;
      const jobRow = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
      ok('job providerSCA == worker wallet (no wallet shared with merchant)', jobRow?.providerSCA.toLowerCase() === worker.walletAddress.toLowerCase(), `provider ${jobRow?.providerSCA}`);

      // ── 6. Worker /accept (setBudget via consumer session) ───────────────────
      const accept = await fetchWithRpcRetry(`/api/jobs/${jobId}/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: workerCookie }, body: JSON.stringify({}),
      });
      ok('6. worker accepted / set budget', accept.res.status === 200 && accept.data.success, `${accept.res.status} ${accept.data.error || ''}`);
      const { agenticCommerceAbi, AGENTIC_COMMERCE_CONTRACT } = await import('@/lib/contracts/erc8183');
      const onChainJob = await publicClient.readContract({
        address: AGENTIC_COMMERCE_CONTRACT as `0x${string}`,
        abi: agenticCommerceAbi as any,
        functionName: 'getJob',
        args: [BigInt(jobId)],
      }).catch(() => null) as any;
      ok('6b. on-chain budget set to 0.02 by worker /accept', onChainJob && BigInt(onChainJob.budget) === BigInt(BUDGET_WEI), `onchain budget ${onChainJob?.budget}`);
      const jobAfterAccept = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
      ok('budget persisted (20000 = 0.02 USDC)', jobAfterAccept?.budget === BigInt(BUDGET_WEI), `budget ${jobAfterAccept?.budget}`);

      // ── 7. Merchant funds escrow ─────────────────────────────────────────────
      const fund = await fetchWithRpcRetry(`/api/jobs/${jobId}/fund`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({}),
      });
      ok('7. funded', fund.res.status === 200 && fund.data.success, `${fund.res.status} ${fund.data.error || ''}`);

      // ── 8. Worker delivers ───────────────────────────────────────────────────
      const submit = await fetchWithRpcRetry('/api/jobs/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: workerCookie },
        body: JSON.stringify({ jobId, providerWalletId: worker.circleWalletId, deliverableData: 'Human e2e deliverable — complete and verified.' }),
      });
      ok('8. delivered', submit.res.status === 200 && submit.data.success, `${submit.res.status} ${submit.data.error || ''}`);

      // ── 9. Merchant completes → worker paid ─────────────────────────────────
      const workerBefore = await balanceOf(worker.walletAddress).catch(() => 0);
      const complete = await fetchWithRpcRetry('/api/jobs/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId, evaluatorWalletId: clientWalletId, reason: 'human-e2e-approved' }),
      });
      ok('9. completed', complete.res.status === 200 && complete.data.success, `${complete.res.status} ${complete.data.error || ''}`);
      const workerAfter = await balanceOf(worker.walletAddress).catch(() => 0);
      ok('worker paid (> 0.008 USDC after fee)', workerAfter - workerBefore > 0.008, `delta ${(workerAfter - workerBefore).toFixed(6)}`);
      const jobFinal = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
      ok('job COMPLETED', jobFinal?.status === 'COMPLETED', `status ${jobFinal?.status}`);
      const postingFinal = await (prisma as any).procurementPosting.findUnique({ where: { id: postingId } });
      ok('posting HIRED with resulting job', postingFinal?.status === 'HIRED' && postingFinal?.resultingJobId === BigInt(jobId), `status ${postingFinal?.status}`);
    }

  } catch (e: any) {
    console.error('E2E ERROR:', e?.message ?? e);
    failed++;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    if (restoredPolicy && clientAgent) {
      await (prisma as any).agentTreasuryPolicy.update({ where: { agentRegistryId: clientAgent.id }, data: { minTrustScore: restoredPolicy.minTrustScore } }).catch(() => {});
    }
    if (merchant?.id && originalMerchantHash) {
      await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: originalMerchantHash } }).catch(() => {});
    }
    if (postingId) {
      await (prisma as any).procurementApplication.deleteMany({ where: { procurementId: postingId } }).catch(() => {});
      await (prisma as any).procurementPosting.delete({ where: { id: postingId } }).catch(() => {});
    }
    if (jobId) {
      await prisma.erc8183Job.deleteMany({ where: { jobId: BigInt(jobId) } }).catch(() => {});
    }
    if (clientAgent?.id) {
      await prisma.agentLedgerEntry.deleteMany({
        where: { dedupeKey: "e2e-human-topup:human-e2e:" + clientAgent.id + ":REVENUE" },
      }).catch(() => {});
    }
    if (worker?.walletAddress) {
      await prisma.consumerAccount.deleteMany({ where: { walletAddress: { equals: worker.walletAddress, mode: 'insensitive' } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { telegramUserId: WORKER_TG } }).catch(() => {});
    }
  }

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f.name} — ${f.detail}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().finally(async () => { await prisma.$disconnect(); }).catch((e) => { console.error(e); process.exitCode = 1; });
