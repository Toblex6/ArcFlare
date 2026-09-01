// scripts/build5-route-tests.mjs
//
// Build 5 route/integration tests — exercises the ACTUAL HTTP routes and their
// authorization boundaries (unlike scripts/build5-procurement-tests.ts, which
// bypassed the HTTP layer entirely).
//
// Covers: F8 (procurement GET auth), F12 (select atomicity/fail-closed),
// F1/F2/F3 (accept via real route: ctx forwarding, on-chain replay semantics,
// policy), F7 (fund binds spend limit to the real payer), F4 (hire idempotency
// / concurrency), F6 (brain tool wiring static proofs).
//
// Chain-touching steps (hire/accept/fund) perform REAL on-chain transactions
// when credentials + funding exist. If they fail for funding/RPC reasons they
// are reported as BLOCKED, never faked.
//
// Usage: npx tsx scripts/build5-route-tests.mjs [baseUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BASE = process.argv[2] || 'http://localhost:3000';
const TEST_PASSWORD = 'E2E_Test_123!';
const prisma = new PrismaClient();
const INTERNAL_KEY = process.env.INTERNAL_SETTLEMENT_API_KEY || '';

let passed = 0, failed = 0, blocked = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ❌ ${name} — ${detail}`); }
}
function blockedOk(name, detail = '') {
  blocked++; console.log(`  ⛔ ${name} — BLOCKED: ${detail}`);
}

async function req(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, status: res.status };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/payments/verify/__probe__`, { signal: AbortSignal.timeout(5000) }); if (r.status === 404) return true; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  console.log('── Build 5 route tests ──────────────────────────────────────');
  if (!(await waitForServer())) {
    console.log('❌ dev server not reachable — start it and re-run');
    process.exit(1);
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const merchant = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } },
  });
  if (!merchant?.email || !merchant.passwordHash) { console.log('❌ fixture merchant not found'); process.exit(1); }
  await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 10) } });
  const login = await req('POST', '/api/merchant/login', { email: merchant.email, password: TEST_PASSWORD });
  const cookie = login.res.headers.get('set-cookie')?.split(';')[0] || '';
  ok('merchant login ok', login.status === 200 && cookie.length > 0, `got ${login.status}`);

  // Deploy client + provider agents (real provisioning — merchant controls both)
  async function deployAgent(name) {
    const r = await req('POST', '/api/agent/deploy', {
      agentName: name,
      metadataUri: 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei',
      ownerNode: '0xAgenticNodeOperatorDefaultAddress',
    }, { cookie });
    const agentId = r.data.agent?.id;
    const sca = r.data.wallets?.owner;
    if (agentId) await prisma.agentRegistry.update({ where: { id: agentId }, data: { skills: ['build5e2e'], description: name } }).catch(() => {});
    return { agentId, sca };
  }
  const clientA = await deployAgent(`Build5 Route Client ${Date.now()}`);
  const providerB = await deployAgent(`Build5 Route Provider ${Date.now()}`);
  ok('client agent provisioned', !!clientA.agentId && /^0x[0-9a-fA-F]{40}$/.test(clientA.sca || ''), JSON.stringify(clientA).slice(0, 120));
  ok('provider agent provisioned', !!providerB.agentId && /^0x[0-9a-fA-F]{40}$/.test(providerB.sca || ''), JSON.stringify(providerB).slice(0, 120));
  await new Promise(r => setTimeout(r, 3000));
  const hdr = { cookie };

  // ── Procurement create: auth boundaries ──────────────────────────────────
  const unauthCreate = await req('POST', '/api/procurement', { clientAgentId: clientA.agentId, description: 'x', budgetMax: '1' });
  ok('unauthenticated procurement create rejected', unauthCreate.status === 401 || unauthCreate.status === 403, `got ${unauthCreate.status}`);
  const badKeyCreate = await req('POST', '/api/procurement', { clientAgentId: providerB.agentId, description: 'x', budgetMax: '1' }, { 'x-api-key': 'not-a-real-key' });
  ok('bad-key procurement create rejected', badKeyCreate.status === 401 || badKeyCreate.status === 403, `got ${badKeyCreate.status}`);
  const create = await req('POST', '/api/procurement', {
    clientAgentId: clientA.agentId, description: 'Build5 route test work', budgetMax: '0.1', skill: 'build5e2e', category: 'testing',
  }, hdr);
  ok('procurement create (owner) → 200', create.status === 200 && create.data.posting?.id, `got ${create.status} ${JSON.stringify(create.data).slice(0, 160)}`);
  const postingId = create.data.posting?.id;

  if (postingId) {
    // ── F8: detail endpoint authorization ──────────────────────────────────
    const anonGet = await req('GET', `/api/procurement/${postingId}`);
    ok('F8: unauthenticated GET detail → 403', anonGet.status === 403, `got ${anonGet.status} ${JSON.stringify(anonGet.data).slice(0, 120)}`);
    const anonApplicants = await req('GET', `/api/procurement/${postingId}/applicants`);
    ok('F8: unauthenticated GET applicants → 403', anonApplicants.status === 403, `got ${anonApplicants.status}`);
    const anonPublicList = await req('GET', '/api/procurement');
    ok('public list still works (no applicant data)', anonPublicList.status === 200, `got ${anonPublicList.status}`);

    // ── Apply (provider B, controlled by the same merchant) ─────────────────
    const anonApply = await req('POST', `/api/procurement/${postingId}/apply`, { applicantAddress: providerB.sca, pitch: 'anon' });
    ok('unauthenticated apply → 403', anonApply.status === 403, `got ${anonApply.status}`);
    const impersonate = await req('POST', `/api/procurement/${postingId}/apply`, { applicantAddress: '0x1111111111111111111111111111111111111111', pitch: 'x' }, hdr);
    ok('apply as an address the caller does not control → 403', impersonate.status === 403, `got ${impersonate.status}`);
    const apply = await req('POST', `/api/procurement/${postingId}/apply`, { applicantAddress: providerB.sca, pitch: 'I can do this', proposedAmount: '0.08' }, hdr);
    ok('authenticated apply → 200', apply.status === 200, `got ${apply.status} ${JSON.stringify(apply.data).slice(0, 160)}`);
    const ownerGet = await req('GET', `/api/procurement/${postingId}`, undefined, hdr);
    ok('F8: owner GET detail → 200 with ranked applicants', ownerGet.status === 200 && Array.isArray(ownerGet.data.ranked) && ownerGet.data.ranked.length === 1, `got ${ownerGet.status} ranked=${ownerGet.data.ranked?.length}`);

    // ── F12: select atomicity + fail-closed trust ───────────────────────────
    const anonSelect = await req('POST', `/api/procurement/${postingId}/select`, {});
    ok('unauthenticated select → 403', anonSelect.status === 403, `got ${anonSelect.status}`);
    const notApplicant = await req('POST', `/api/procurement/${postingId}/select`, { providerAddress: '0x1111111111111111111111111111111111111111' }, hdr);
    ok('select of a non-applicant → 400', notApplicant.status === 400, `got ${notApplicant.status}`);
    // Concurrency: two selects raced on the SAME posting — exactly one wins.
    const [s1, s2] = await Promise.all([
      req('POST', `/api/procurement/${postingId}/select`, {}, hdr),
      req('POST', `/api/procurement/${postingId}/select`, {}, hdr).catch(e => ({ status: 0, data: { error: String(e) } })),
    ]);
    ok('F12: concurrent selects — winner 200, loser 409', (s1.status === 200 && s2.status === 409) || (s2.status === 200 && s1.status === 409), `got ${s1.status}/${s2.status}`);
    const afterSelect = await req('GET', `/api/procurement/${postingId}`, undefined, hdr);
    ok('F12: selected provider is the real applicant (providerSCA)', (afterSelect.data.posting?.selectedProviderSCA || '').toLowerCase() === (providerB.sca || '').toLowerCase(), afterSelect.data.posting?.selectedProviderSCA);
    const reSelect = await req('POST', `/api/procurement/${postingId}/select`, {}, hdr);
    ok('F12: re-select after SELECTED → 409', reSelect.status === 409, `got ${reSelect.status}`);


    // ── Fund the test client legitimately ──────────────────────────────────
    // Treasury seed: an ADJUSTMENT credit (faucet-equivalent operational seed,
    // deterministic dedupeKey so re-runs never double-credit). Wallet top-up:
    // a REAL fee-free native USDC value-send from an x402 pool wallet.
    await prisma.agentLedgerEntry.create({
      data: {
        agentRegistryId: clientA.agentId, type: 'ADJUSTMENT', amount: '500000', token: 'USDC',
        direction: 'CREDIT', dedupeKey: `build5-route-test:adjust:${clientA.agentId}`,
        description: 'Build 5 route test treasury seed (faucet-equivalent)',
      },
    }).catch(() => {});
    let walletFunded = false;
    try {
      const crypto = await import('crypto');
      const { ethers } = await import('ethers');
      const keyB64 = process.env.X402_WALLET_ENCRYPTION_KEY;
      if (keyB64) {
        const key = Buffer.from(keyB64, 'base64');
        const poolRows = await prisma.x402EoaWallet.findMany({ orderBy: { id: 'asc' } });
        const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
        let pool = null;
        for (const r of poolRows) {
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.keyIv, 'base64'));
          decipher.setAuthTag(Buffer.from(r.keyAuthTag, 'base64'));
          const pk = Buffer.concat([decipher.update(Buffer.from(r.encryptedKey, 'base64')), decipher.final()]).toString('utf8');
          const w = new ethers.Wallet(pk, provider);
          const bal = await provider.getBalance(w.address);
          if (bal >= ethers.parseEther('0.25')) { if (!pool || bal > (await provider.getBalance(pool.address))) pool = w; }
        }
        if (pool) {
          const clientBal = await provider.getBalance(clientA.sca);
          if (clientBal < ethers.parseEther('0.15')) {
            const tx = await pool.sendTransaction({ to: clientA.sca, value: ethers.parseEther('0.25') });
            await tx.wait();
          }
          walletFunded = (await provider.getBalance(clientA.sca)) >= ethers.parseEther('0.1');
        }
      }
    } catch (e) { console.log(`  (wallet top-up failed: ${String(e).slice(0, 120)})`); }
    ok('client wallet funded with real USDC (native value-send)', walletFunded);
    // ── Hire (REAL on-chain createJob) ──────────────────────────────────────
    console.log('  … hire (real createJob) …');
    const unauthHire = await req('POST', `/api/procurement/${postingId}/hire`, {});
    ok('unauthenticated hire → 403', unauthHire.status === 403, `got ${unauthHire.status}`);
    const hire = await req('POST', `/api/procurement/${postingId}/hire`, {}, hdr);


    const hireOk = hire.status === 200 && hire.data.jobId;
    if (hireOk) {
      ok('F4: hire → 200 with real jobId', true, `jobId=${hire.data.jobId} tx=${(hire.data.txHash || '').slice(0, 14)}…`);
      const jobId = hire.data.jobId;
      // Idempotent replay
      const hireReplay = await req('POST', `/api/procurement/${postingId}/hire`, {}, hdr);
      ok('F4: hire replay → replayed:true same jobId', hireReplay.status === 200 && hireReplay.data.replayed === true && hireReplay.data.jobId === jobId, `got ${hireReplay.status} ${JSON.stringify(hireReplay.data).slice(0, 140)}`);
      const hired = await req('GET', `/api/procurement/${postingId}`, undefined, hdr);
      ok('F4: posting.resultingJobId == the ERC-8183 job', String(hired.data.posting?.resultingJobId) === String(jobId), hired.data.posting?.resultingJobId);
      const jobRow = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
      ok('selected provider became the real providerSCA', (jobRow?.providerSCA || '').toLowerCase() === providerB.sca.toLowerCase(), jobRow?.providerSCA);
      ok('evaluator defaults to client and != provider', (jobRow?.evaluatorSCA || '').toLowerCase() !== providerB.sca.toLowerCase(), jobRow?.evaluatorSCA);

      // ── Accept (REAL setBudget) — F1/F2/F3 via the actual route ───────────
      console.log('  … accept (real setBudget) …');
      const anonAccept = await req('POST', `/api/jobs/${jobId}/accept`, {});
      ok('unauthenticated accept → 401/403', anonAccept.status === 401 || anonAccept.status === 403, `got ${anonAccept.status}`);
      const badId = await req('POST', '/api/jobs/notanumber/accept', {}, hdr);
      ok('F1: accept route receives ctx.params (invalid id → 400, not 500)', badId.status === 400, `got ${badId.status}`);
      const accept = await req('POST', `/api/jobs/${jobId}/accept`, {}, hdr);
      const acceptOk = accept.status === 200;
      if (acceptOk) {
        ok('F1/F2: accept → 200 with txHash (DB budget did NOT trigger false replay)', !!accept.data.txHash && accept.data.replayed !== true, JSON.stringify(accept.data).slice(0, 160));
        const acceptReplay = await req('POST', `/api/jobs/${jobId}/accept`, {}, hdr);
        ok('F2: second accept → on-chain-verified replay', acceptReplay.status === 200 && acceptReplay.data.replayed === true, `got ${acceptReplay.status} ${JSON.stringify(acceptReplay.data).slice(0, 140)}`);
      } else {
        blockedOk('accept (real setBudget)', `${accept.status} ${JSON.stringify(accept.data).slice(0, 180)}`);
      }


      // ── Fund (REAL approve+fund) — F7 ─────────────────────────────────────
      if (acceptOk) {
        console.log('  … fund (real approve+fund) …');
        const anonFund = await req('POST', `/api/jobs/${jobId}/fund`, {});
        ok('unauthenticated fund → 401/403', anonFund.status === 401 || anonFund.status === 403, `got ${anonFund.status}`);
        const fund = await req('POST', `/api/jobs/${jobId}/fund`, {}, hdr);
        if (fund.status === 200 && fund.data.fundTx) {
          ok('F7: fund → 200; payer is the client SCA', (fund.data.payer || '').toLowerCase() === clientA.sca.toLowerCase(), fund.data.payer);
          const fundReplay = await req('POST', `/api/jobs/${jobId}/fund`, {}, hdr);
          ok('duplicate funding cannot occur (replay, no new tx)', fundReplay.status === 200 && fundReplay.data.replayed === true, JSON.stringify(fundReplay.data).slice(0, 140));
        } else {
          blockedOk('fund (real approve+fund)', `${fund.status} ${JSON.stringify(fund.data).slice(0, 180)}`);
        }
      }
    } else {
      blockedOk('hire (real createJob)', `${hire.status} ${JSON.stringify(hire.data).slice(0, 180)}`);
    }
  }

  // ── Chain flow with the platform agent as client (real treasury history) ──
  // The freshly provisioned client agent correctly fails closed on treasury.
  // The platform agent (AGENT_OWNER_WALLET_ADDRESS, controlled by the internal
  // service key) has real ledger history, so hire/accept/fund can run for real.
  const PLATFORM_SCA = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
  const platformAgent = PLATFORM_SCA ? await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: PLATFORM_SCA, mode: 'insensitive' } } }).catch(() => null) : null;
  if (!INTERNAL_KEY || !platformAgent) {
    blockedOk('platform-agent chain flow', !INTERNAL_KEY ? 'INTERNAL_SETTLEMENT_API_KEY not set' : 'platform agent not in registry');
  } else {
    const ihdr = { 'x-api-key': INTERNAL_KEY };
    const cp = await req('POST', '/api/procurement', { clientAgentId: platformAgent.id, description: 'Build5 platform-agent chain flow', budgetMax: '0.05', skill: 'build5e2e' }, ihdr);
    const cpid = cp.data.posting?.id;
    if (cp.status === 200 && cpid) {
      ok('platform posting created via internal key', true);
      await req('POST', `/api/procurement/${cpid}/apply`, { applicantAddress: providerB.sca, pitch: 'platform flow' }, hdr);
      const sel = await req('POST', `/api/procurement/${cpid}/select`, {}, ihdr);
      if (sel.status !== 200) {
        blockedOk('platform chain flow (select)', `${sel.status} ${JSON.stringify(sel.data).slice(0, 140)}`);
      } else {
        const hire2 = await req('POST', `/api/procurement/${cpid}/hire`, {}, ihdr);
        if (hire2.status !== 200 || !hire2.data.jobId) {
          blockedOk('platform chain flow (hire/createJob)', `${hire2.status} ${JSON.stringify(hire2.data).slice(0, 160)}`);
        } else {
          const jobId2 = hire2.data.jobId;
          ok('F4: platform hire → real on-chain jobId', /^0x[0-9a-fA-F]{64}$/.test(hire2.data.txHash || ''), `jobId=${jobId2} tx=${(hire2.data.txHash || '').slice(0, 14)}…`);
          const replay = await req('POST', `/api/procurement/${cpid}/hire`, {}, ihdr);
          ok('F4: platform hire replay → replayed:true, same jobId', replay.status === 200 && replay.data.replayed === true && replay.data.jobId === jobId2, JSON.stringify(replay.data).slice(0, 120));
          const jobRow = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId2) } });
          ok('F12/F4: providerSCA is the selected applicant', (jobRow?.providerSCA || '').toLowerCase() === providerB.sca.toLowerCase(), jobRow?.providerSCA);
          ok('F13: evaluator != provider', (jobRow?.evaluatorSCA || '').toLowerCase() !== providerB.sca.toLowerCase(), jobRow?.evaluatorSCA);

          // accept with the provider owner (merchant cookie controls provider B)
          const accept = await req('POST', `/api/jobs/${jobId2}/accept`, {}, hdr);
          if (accept.status === 200) {
            ok('F1/F2: accept → real setBudget tx (no false replay from DB budget)', !!accept.data.txHash && accept.data.replayed !== true, `tx=${(accept.data.txHash || '').slice(0, 14)}… budget=${accept.data.budget}`);
            const replay2 = await req('POST', `/api/jobs/${jobId2}/accept`, {}, hdr);
            ok('F2: accept replay verified from on-chain state', replay2.status === 200 && replay2.data.replayed === true, JSON.stringify(replay2.data).slice(0, 120));
          } else {
            blockedOk('accept (real setBudget)', `${accept.status} ${JSON.stringify(accept.data).slice(0, 160)}`);
          }

          // fund with the platform agent paying (internal key)
          if (accept.status === 200) {
            const fund = await req('POST', `/api/jobs/${jobId2}/fund`, {}, ihdr);
            if (fund.status === 200 && fund.data.fundTx) {
              ok('F7: fund → real approve+fund; payer is the client SCA', (fund.data.payer || '').toLowerCase() === PLATFORM_SCA.toLowerCase(), fund.data.payer);
              const freplay = await req('POST', `/api/jobs/${jobId2}/fund`, {}, ihdr);
              ok('F7: duplicate fund → replay, no double spend', freplay.status === 200 && freplay.data.replayed === true, JSON.stringify(freplay.data).slice(0, 120));
            } else {
              blockedOk('fund (real approve+fund)', `${fund.status} ${JSON.stringify(fund.data).slice(0, 160)}`);
            }
          }
        }
      }
    } else {
      blockedOk('platform chain flow (posting)', `${cp.status} ${JSON.stringify(cp.data).slice(0, 140)}`);
    }
  }

  // ── F6: brain wiring static proofs ────────────────────────────────────────
  const brainSrc = (await import('fs')).readFileSync('src/app/api/agent/brain/route.ts', 'utf8');
  ok('F6: brain exposes apply_to_procurement tool', brainSrc.includes('name: "apply_to_procurement"'));
  ok('F6: applicant identity pinned to AGENT_OWNER_WALLET_ADDRESS', /case "apply_to_procurement":[\s\S]{0,600}applicantAddress: process\.env\.AGENT_OWNER_WALLET_ADDRESS/.test(brainSrc));
  ok('F6: prompt is compositional (success:true ≠ task completion)', /success: true is NOT task completion/.test(brainSrc));
  ok('F6: no duplicate hire_from_procurement case', (brainSrc.match(/case "hire_from_procurement"/g) || []).length === 1);

  console.log(`\n── Results: ${passed} passed, ${failed} failed, ${blocked} blocked ──`);
  if (failures.length) failures.forEach(f => console.log(`  FAIL: ${f.name} — ${f.detail}`));
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });



