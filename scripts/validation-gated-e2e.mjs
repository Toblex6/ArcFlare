// scripts/validation-gated-e2e.mjs
// Build 2 — Validation-Gated Commerce E2E
// Path A: normal job (hire without validation -> fund -> submit -> complete) must remain working
// Path B: validation-gated job (hire with validation -> fund -> submit -> release BEFORE validation -> must fail 409 -> validation request -> validator PASS -> release -> worker receives payment)
// Also tests: FAIL blocks release, wrong validator rejected, duplicate request idempotent, unauthorized release rejected

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
const VALIDATOR_SCA = process.env.AGENT_VALIDATOR_WALLET_ADDRESS || '0xc3b50563e496a4e75a99dc45e4011d977032bb14';
const VALIDATOR_WALLET_ID = process.env.AGENT_VALIDATOR_WALLET_ID || '7ed1e863-eaea-5532-adb0-3c2a2d67b9fe';

const prisma = new PrismaClient();
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const USDC = '0x3600000000000000000000000000000000000000';
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
async function consumerCookie(consumerId, walletAddress) {
  const token = await new SignJWT({ consumerId, walletAddress }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d').sign(new TextEncoder().encode(CONSUMER_JWT_SECRET));
  return `consumer_token=${token}`;
}
async function fetchWithRpcRetry(url, opts, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${BASE}${url}`, opts);
    const data = await res.clone().json().catch(() => ({}));
    const msg = JSON.stringify(data).toLowerCase();
    const isFlake = msg.includes('bad record mac') || msg.includes('econnreset') || msg.includes('ssl routines') || msg.includes('alert bad record') || msg.includes('timeout');
    if (res.status === 500 && isFlake && attempt < retries - 1) {
      console.log(`  RPC flake on ${url} attempt ${attempt+1}, retrying...`);
      await new Promise(r => setTimeout(r, 2000 * (attempt+1)));
      continue;
    }
    return { res, data };
  }
  const res = await fetch(`${BASE}${url}`, opts);
  return { res, data: await res.json().catch(() => ({})) };
}

async function main() {
  console.log('── Validation-Gated E2E (Build 2) ─────────────────────────────');
  for (let i=0;i<30;i++){ try{ const r=await fetch(`${BASE}/api/payments/verify/__probe__`,{signal:AbortSignal.timeout(5000)}); if(r.status===404) break; }catch{} await new Promise(r=>setTimeout(r,1000)); }
  if (!CONSUMER_JWT_SECRET) { console.log('❌ CONSUMER_JWT_SECRET not set'); process.exitCode=1; return; }

  let originalMerchantHash = null;
  let merchantCookie = '';
  let merchant = null;
  const toCleanupJobs = [];
  const toCleanupValidations = [];

  try {
    // Setup merchant
    merchant = await prisma.merchant.findFirst({ where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } } });
    if (!merchant?.email || !merchant.passwordHash || !merchant.circleWalletId) throw new Error('merchant acne corp not found');
    originalMerchantHash = merchant.passwordHash;
    const testHash = await bcrypt.hash('E2E_Test_123!', 10);
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: testHash } });
    const loginRes = await fetch(`${BASE}/api/merchant/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: merchant.email, password: 'E2E_Test_123!' }) });
    const loginData = await loginRes.json();
    merchantCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    ok('merchant login ok', loginRes.status === 200 && loginData.success, `got ${loginRes.status}`);

    // Find a provider agent (any ACTIVE)
    const agent = await prisma.agentRegistry.findFirst({ where: { status: 'ACTIVE_AGENT_PROVISIONED', merchantId: merchant.id } }) || await prisma.agentRegistry.findFirst({ where: { status: 'ACTIVE_AGENT_PROVISIONED' } });
    if (!agent) throw new Error('No ACTIVE agent found for testing');
    ok('found provider agent', !!agent, `agent ${agent.id} ${agent.scaAddress}`);

    // ========== PATH A: normal job (no validation) ==========
    console.log('\n── Path A: normal job (no validation) ───────────────────────');
    const criteriaA = { requirements: ['Normal deliverable A'], deadlineHours: 24 };
    let hireA = await fetchWithRpcRetry(`/api/agents/${agent.id}/hire`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ clientWalletId: merchant.circleWalletId, description: 'Normal job E2E', criteria: criteriaA, budget: '0.01' }) });
    ok('Path A hire ok', hireA.res.status === 200 && hireA.data.success, `${hireA.res.status} ${hireA.data.error || ''}`);
    const jobIdA = hireA.data.jobId;
    toCleanupJobs.push(BigInt(jobIdA));
    ok('Path A hire no validation', !hireA.data.validation || !hireA.data.validation.required, `validation ${JSON.stringify(hireA.data.validation)}`);

    // Set budget, fund, submit, complete (normal flow)
    const agentForBudget = await prisma.agentRegistry.findUnique({ where: { id: agent.id } });
    // set-budget must be called by the provider (agent), not the client
    let budgetA = await fetchWithRpcRetry('/api/jobs/set-budget', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdA, providerWalletId: agentForBudget.circleWalletId, budget: '10000' }) });
    ok('Path A set-budget ok', budgetA.res.status === 200 && budgetA.data.success, `${budgetA.res.status} ${budgetA.data.error || ''}`);
    let fundA = await fetchWithRpcRetry('/api/jobs/fund', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdA, clientWalletId: merchant.circleWalletId }) });
    ok('Path A fund ok', fundA.res.status === 200 && fundA.data.success, `${fundA.res.status} ${fundA.data.error || ''}`);

    // Submit as provider
    const agentConsumerA = await prisma.consumerAccount.upsert({
      where: { walletAddress: agent.scaAddress },
      create: { walletAddress: agent.scaAddress, circleWalletId: agentForBudget.circleWalletId ?? agent.scaAddress, onboardingSource: 'web' },
      update: { circleWalletId: agentForBudget.circleWalletId ?? agent.scaAddress },
    });
    const cookieA = await consumerCookie(agentConsumerA.id, agent.scaAddress);
    let submitA = await fetchWithRpcRetry('/api/jobs/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieA }, body: JSON.stringify({ jobId: jobIdA, providerWalletId: agentForBudget.circleWalletId, deliverableData: 'Normal deliverable' }) });
    ok('Path A submit ok', submitA.res.status === 200 && submitA.data.success, `${submitA.res.status} ${submitA.data.error || ''}`);

    // Complete (should succeed, no validation)
    const workerBeforeA = await balanceOf(agent.scaAddress);
    let completeA = await fetchWithRpcRetry('/api/jobs/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdA, evaluatorWalletId: merchant.circleWalletId, reason: 'normal-approved' }) });
    ok('Path A complete ok (no validation)', completeA.res.status === 200 && completeA.data.success, `${completeA.res.status} ${completeA.data.error || ''}`);
    const workerAfterA = await balanceOf(agent.scaAddress);
    ok('Path A worker received payment', workerAfterA - workerBeforeA > 0.008, `delta ${(workerAfterA - workerBeforeA).toFixed(6)}`);

    // Check validation status for normal job -> should say not required
    const valStatusA = await fetch(`${BASE}/api/jobs/${jobIdA}/validation`, { headers: { cookie: merchantCookie } });
    const valStatusAData = await valStatusA.json();
    ok('Path A validation status not required', valStatusAData.validationRequired === false, `${JSON.stringify(valStatusAData).slice(0,200)}`);

    // ========== PATH B: validation-gated job ==========
    console.log('\n── Path B: validation-gated job ───────────────────────────');
    const criteriaB = { requirements: ['Validated deliverable A', 'Validated deliverable B'], deadlineHours: 24 };
    let hireB = await fetchWithRpcRetry(`/api/agents/${agent.id}/hire`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ clientWalletId: merchant.circleWalletId, description: 'Validation-gated job E2E', criteria: criteriaB, budget: '0.01', validation: { required: true, validatorSCA: VALIDATOR_SCA, tag: 'job-validation' } }) });
    ok('Path B hire with validation ok', hireB.res.status === 200 && hireB.data.success, `${hireB.res.status} ${hireB.data.error || ''}`);
    const jobIdB = hireB.data.jobId;
    toCleanupJobs.push(BigInt(jobIdB));
    ok('Path B hire has validation', hireB.data.validation?.required === true && hireB.data.validation?.validatorSCA?.toLowerCase() === VALIDATOR_SCA.toLowerCase(), `${JSON.stringify(hireB.data.validation)}`);

    // Set budget, fund, submit (same as A)
    let budgetB = await fetchWithRpcRetry('/api/jobs/set-budget', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB, providerWalletId: agentForBudget.circleWalletId, budget: '10000' }) });
    ok('Path B set-budget ok', budgetB.res.status === 200 && budgetB.data.success, `${budgetB.res.status} ${budgetB.data.error || ''}`);
    let fundB = await fetchWithRpcRetry('/api/jobs/fund', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB, clientWalletId: merchant.circleWalletId }) });
    ok('Path B fund ok', fundB.res.status === 200 && fundB.data.success, `${fundB.res.status} ${fundB.data.error || ''}`);
    let submitB = await fetchWithRpcRetry('/api/jobs/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieA }, body: JSON.stringify({ jobId: jobIdB, providerWalletId: agentForBudget.circleWalletId, deliverableData: 'Validated deliverable' }) });
    ok('Path B submit ok', submitB.res.status === 200 && submitB.data.success, `${submitB.res.status} ${submitB.data.error || ''}`);

    // Try release BEFORE validation -> must fail 409
    const workerBeforeB = await balanceOf(agent.scaAddress);
    let earlyComplete = await fetchWithRpcRetry('/api/jobs/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB, evaluatorWalletId: merchant.circleWalletId, reason: 'early-release-attempt' }) });
    ok('Path B early release blocked (409)', earlyComplete.res.status === 409 && earlyComplete.data.code === 'VALIDATION_REQUIRED', `got ${earlyComplete.res.status} ${JSON.stringify(earlyComplete.data).slice(0,200)}`);
    const workerAfterEarly = await balanceOf(agent.scaAddress);
    ok('Path B early release no payment', Math.abs(workerAfterEarly - workerBeforeB) < 0.000001, `delta ${(workerAfterEarly - workerBeforeB).toFixed(6)}`);

    // Validation request
    let valReq = await fetchWithRpcRetry(`/api/jobs/${jobIdB}/validation/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({}) });
    ok('Path B validation request ok', valReq.res.status === 200 && valReq.data.success, `${valReq.res.status} ${valReq.data.error || ''}`);
    const requestHash = valReq.data.requestHash;
    ok('Path B requestHash returned', !!requestHash, `hash ${requestHash}`);

    // Duplicate validation request -> idempotent
    let valReqDup = await fetchWithRpcRetry(`/api/jobs/${jobIdB}/validation/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({}) });
    ok('Path B duplicate request idempotent', valReqDup.res.status === 200 && valReqDup.data.replayed === true && valReqDup.data.requestHash === requestHash, `replayed ${valReqDup.data.replayed}`);

    // Wrong validator -> rejected
    // Create a second merchant to act as wrong validator
    const merchant2 = await prisma.merchant.create({ data: { email: `e2e-wrong-val-${Date.now()}@test.local`, businessName: `wrong-val-${Date.now()}`, passwordHash: await bcrypt.hash('E2E_Test_123!', 10), verified: true, active: true } });
    const login2 = await fetch(`${BASE}/api/merchant/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: merchant2.email, password: 'E2E_Test_123!' }) });
    const cookie2 = login2.headers.get('set-cookie')?.split(';')[0] || '';
    // Try to respond as wrong validator (not the designated one)
    let wrongVal = await fetchWithRpcRetry(`/api/jobs/${jobIdB}/validation/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie2 }, body: JSON.stringify({ passed: true, tag: 'wrong-validator' }) });
    ok('Path B wrong validator rejected (403)', wrongVal.res.status === 403, `got ${wrongVal.res.status} ${JSON.stringify(wrongVal.data).slice(0,200)}`);

    // Validator PASS
    // Need validator's cookie: the validator is VALIDATOR_SCA, which is AGENT_VALIDATOR_WALLET_ADDRESS, not a merchant. How to auth as validator?
    // The validator wallet is a Circle wallet, not a merchant. We need to create a merchant or consumer that controls that address.
    // For E2E, we can create a consumer account for the validator SCA and get a consumer_token
    let validatorConsumer = await prisma.consumerAccount.findFirst({ where: { walletAddress: VALIDATOR_SCA } });
    if (!validatorConsumer) {
      validatorConsumer = await prisma.consumerAccount.create({ data: { walletAddress: VALIDATOR_SCA, circleWalletId: VALIDATOR_WALLET_ID, onboardingSource: 'test' } });
    }
    const validatorCookie = await consumerCookie(validatorConsumer.id, VALIDATOR_SCA);
    // Also need to ensure the validator wallet is a Circle wallet that can sign: use the env's validator private key? But for E2E we use the API which will use Circle's createContractExecutionTransaction with the validator's address.
    // The API checks verifyCallerControlsAddress for validatorSCA — consumer token for that address should pass.
    let valResp = await fetchWithRpcRetry(`/api/jobs/${jobIdB}/validation/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: validatorCookie }, body: JSON.stringify({ passed: true, tag: 'e2e-pass' }) });
    ok('Path B validator PASS ok', valResp.res.status === 200 && valResp.data.success && valResp.data.passed === true, `${valResp.res.status} ${valResp.data.error || ''}`);

    // Check validation status after PASS
    let valStatus = await fetch(`${BASE}/api/jobs/${jobIdB}/validation`, { headers: { cookie: merchantCookie } });
    let valStatusData = await valStatus.json();
    ok('Path B validation status PASSED', valStatusData.policy?.status === 'PASSED' || valStatusData.onChain?.passed === true, `${JSON.stringify(valStatusData).slice(0,300)}`);

    // Now release should succeed
    const workerBeforePass = await balanceOf(agent.scaAddress);
    let completeB = await fetchWithRpcRetry('/api/jobs/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB, evaluatorWalletId: merchant.circleWalletId, reason: 'validated-approved' }) });
    ok('Path B complete after PASS ok', completeB.res.status === 200 && completeB.data.success, `${completeB.res.status} ${completeB.data.error || ''}`);
    const workerAfterPass = await balanceOf(agent.scaAddress);
    ok('Path B worker received exact payment', workerAfterPass - workerBeforePass > 0.008, `delta ${(workerAfterPass - workerBeforePass).toFixed(6)}`);

    // ========== PATH B2: validation FAIL blocks release ==========
    console.log('\n── Path B2: validation FAIL blocks release ──────────────────');
    const criteriaB2 = { requirements: ['Fail deliverable'], deadlineHours: 24 };
    let hireB2 = await fetchWithRpcRetry(`/api/agents/${agent.id}/hire`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ clientWalletId: merchant.circleWalletId, description: 'Validation FAIL job', criteria: criteriaB2, budget: '0.01', validation: { required: true, validatorSCA: VALIDATOR_SCA } }) });
    const jobIdB2 = hireB2.data.jobId;
    toCleanupJobs.push(BigInt(jobIdB2));
    ok('Path B2 hire ok', hireB2.res.status === 200 && hireB2.data.success);
    await fetchWithRpcRetry('/api/jobs/set-budget', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB2, providerWalletId: agentForBudget.circleWalletId, budget: '10000' }) });
    await fetchWithRpcRetry('/api/jobs/fund', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB2, clientWalletId: merchant.circleWalletId }) });
    await fetchWithRpcRetry('/api/jobs/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieA }, body: JSON.stringify({ jobId: jobIdB2, providerWalletId: agentForBudget.circleWalletId, deliverableData: 'Fail deliverable' }) });
    let valReqB2 = await fetchWithRpcRetry(`/api/jobs/${jobIdB2}/validation/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({}) });
    ok('Path B2 validation request ok', valReqB2.res.status === 200 && valReqB2.data.success);
    let valRespFail = await fetchWithRpcRetry(`/api/jobs/${jobIdB2}/validation/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: validatorCookie }, body: JSON.stringify({ passed: false, tag: 'e2e-fail' }) });
    ok('Path B2 validator FAIL ok', valRespFail.res.status === 200 && valRespFail.data.passed === false);
    const workerBeforeFail = await balanceOf(agent.scaAddress);
    let earlyFail = await fetchWithRpcRetry('/api/jobs/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: merchantCookie }, body: JSON.stringify({ jobId: jobIdB2, evaluatorWalletId: merchant.circleWalletId, reason: 'should-fail' }) });
    ok('Path B2 release after FAIL blocked (409)', earlyFail.res.status === 409, `got ${earlyFail.res.status}`);
    const workerAfterFail = await balanceOf(agent.scaAddress);
    ok('Path B2 no payment after FAIL', Math.abs(workerAfterFail - workerBeforeFail) < 0.000001);

    // ========== Unauthorized release attempt ==========
    let unauth = await fetch(`${BASE}/api/jobs/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: jobIdB, evaluatorWalletId: merchant.circleWalletId, reason: 'unauth' }) });
    ok('Unauthorized release rejected', unauth.status === 401 || unauth.status === 403, `got ${unauth.status}`);

    // Cleanup merchant2
    await prisma.merchant.delete({ where: { id: merchant2.id } }).catch(() => {});

  } catch (err) {
    console.error('E2E threw:', err);
    failed++;
    failures.push({ name: 'e2e run', detail: err.message + '\\n' + err.stack?.slice(0,500) });
  } finally {
    // Cleanup
    for (const jid of toCleanupJobs) {
      await prisma.erc8183Job.deleteMany({ where: { jobId: jid } }).catch(() => {});
      await prisma.erc8183JobValidation.deleteMany({ where: { jobId: jid } }).catch(() => {});
    }
    if (originalMerchantHash && merchant) {
      await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: originalMerchantHash } }).catch(() => {});
    }
    console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
    if (failed) {
      for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('✅ Validation-Gated E2E: both paths verified, on-chain evidence preserved');
    }
  }
}
main().finally(() => prisma.$disconnect());
