// scripts/agent-pay-e2e.ts
//
// Real testnet E2E for the agent-payments feature (roadmap batch):
//   GET /api/agents/[id]/wallet  — auto-provisioned per-agent x402 payment EOA
//   POST /api/agents/[id]/policy — ArcFlareSpendLimit.setLimit (spending policy)
//   POST /api/agents/[id]/pay    — agent-to-agent payment: spend-limit pre-flight,
//                                  on-chain checkAndRecordSpend BEFORE transfer,
//                                  NATIVE value-send (fee-free, measured
//                                  2026-08-18), recipient credit delta verified
//                                  on-chain, PaymentLog with the real tx hash.
//
// Proof asserted here (real balance deltas, not status codes):
//   - recipient EOA balanceOf delta == amount EXACTLY (native send credits 1:1)
//   - payer agent EOA balanceOf delta == amount + gas only (no transfer fee)
//   - spentInWindow delta == amount on ArcFlareSpendLimit
//   - over-cap attempt -> 403 BEFORE any funds move (recipient unchanged,
//     spentInWindow unchanged)
//
// Run with the dev server on :3000:  npx tsx scripts/agent-pay-e2e.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import bcrypt from 'bcryptjs';
import { ethers } from 'ethers';
import { prisma } from '@/lib/prisma';
import { getRelayerSigner } from '@/lib/wallet/jobEscrowClient';
import { getSpendLimitContract } from '@/lib/agents/spendLimitEnforcer';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const TEST_PASSWORD = 'E2E_Test_123!';
const USDC = '0x3600000000000000000000000000000000000000';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, info = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${info ? ' — ' + info : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? ' — ' + info : ''}`); }
};

async function main() {
  // ── merchant A (the actor controlling both agents) ─────────────────────
  const merchant = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true },
  });
  if (!merchant?.email || !merchant.passwordHash) throw new Error('merchant A not found');
  const originalHash = merchant.passwordHash;
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 10) },
  });

  const payerKey = ethers.Wallet.createRandom();
  const recipientKey = ethers.Wallet.createRandom();
  let payerAgentId = 0, recipientAgentId = 0;

  try {
    const loginRes = await fetch(`${BASE}/api/merchant/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: merchant.email, password: TEST_PASSWORD }),
    });
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    ok('merchant A login ok', loginRes.status === 200 && cookie.length > 0, `got ${loginRes.status}`);

    // ── provision two agents owned by merchant A ──────────────────────────
    const agentRow = await prisma.agentRegistry.create({
      data: {
        name: 'E2E Payer Agent',
        tokenId: '851101',
        scaAddress: payerKey.address,
        ownerNode: merchant.walletAddress ?? '',
        status: 'ACTIVE',
        merchantId: merchant.id,
      },
    });
    payerAgentId = agentRow.id;
    const agentRow2 = await prisma.agentRegistry.create({
      data: {
        name: 'E2E Recipient Agent',
        tokenId: '851102',
        scaAddress: recipientKey.address,
        ownerNode: merchant.walletAddress ?? '',
        status: 'ACTIVE',
        merchantId: merchant.id,
      },
    });
    recipientAgentId = agentRow2.id;
    ok('two AgentRegistry rows provisioned', payerAgentId > 0 && recipientAgentId > 0, `payer ${payerAgentId}, recipient ${recipientAgentId}`);

    // ── GET /api/agents/[id]/wallet — auto-provisioned payment EOA ────────
    const walletRes = await fetch(`${BASE}/api/agents/${payerAgentId}/wallet`, { headers: { cookie } });
    const walletBody = await walletRes.json();
    const agentEoa = walletBody.address ?? '';
    ok('GET wallet: auto-provisioned agent EOA', walletRes.status === 200 && /^0x[a-fA-F0-9]{40}$/.test(agentEoa), `agent EOA ${agentEoa}`);

    const walletRes2 = await fetch(`${BASE}/api/agents/${payerAgentId}/wallet`, { headers: { cookie } });
    const walletBody2 = await walletRes2.json();
    ok('GET wallet: idempotent (same EOA on repeat)', walletBody2.address === agentEoa, `repeat ${walletBody2.address ?? 'none'}`);

    const recipientWalletRes = await fetch(`${BASE}/api/agents/${recipientAgentId}/wallet`, { headers: { cookie } });
    const recipientEoa = (await recipientWalletRes.json()).address ?? '';
    ok('recipient agent EOA provisioned', /^0x[a-fA-F0-9]{40}$/.test(recipientEoa), recipientEoa);

    // ── fund the payer agent EOA: native value-send (fee-free) ────────────
    const relayer = getRelayerSigner();
    const erc20 = new ethers.Contract(USDC, ERC20_ABI, relayer);
    const balBefore = Number(await erc20.balanceOf(agentEoa)) / 1e6;
    if (balBefore < 1.0) {
      const fundTx = await relayer.sendTransaction({ to: agentEoa, value: ethers.parseEther('1.0') });
      await fundTx.wait();
      console.log(`  funded agent EOA +1.0 USDC via native send (tx ${fundTx.hash.slice(0, 12)}…)`);
    }
    const agentBal = Number(await erc20.balanceOf(agentEoa)) / 1e6;
    ok('payer agent EOA funded (1.0 native send credited 1:1)', agentBal >= 1.0, `${agentBal.toFixed(4)} USDC`);

    // ── POST /api/agents/[id]/policy — spending policy (setLimit) ─────────
    const policyRes = await fetch(`${BASE}/api/agents/${payerAgentId}/policy`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capPerWindow: '2', windowSeconds: 86400 }),
    });
    const policyBody = await policyRes.json();
    ok('POST policy: setLimit accepted', policyRes.status === 200 && /^0x[a-fA-F0-9]{64}$/.test(policyBody.txHash ?? ''), `tx ${(policyBody.txHash ?? '').slice(0, 12)}…`);

    const limit = await getSpendLimitContract().getLimit(agentEoa);
    ok('policy on-chain: cap 2 USDC / 86400s window', Number(limit.capPerWindow) === 2_000_000 && Number(limit.windowSeconds) === 86400,
      `cap ${Number(limit.capPerWindow) / 1e6}, window ${limit.windowSeconds}, spent ${Number(limit.spentInWindow) / 1e6}`);

    const policyGet = await fetch(`${BASE}/api/agents/${payerAgentId}/policy`, { headers: { cookie } });
    const policyGetBody = await policyGet.json();
    ok('GET policy: mirrors on-chain limit', policyGet.status === 200 && Number(policyGetBody.capPerWindow) === 2,
      `cap ${policyGetBody.capPerWindow}, spent ${policyGetBody.spentInWindow}`);

    // ── POST /api/agents/[id]/pay — agent-to-agent payment ────────────────
    const AMOUNT = '0.25';
    const recvBefore = Number(await erc20.balanceOf(recipientEoa)) / 1e6;
    const payerBefore = Number(await erc20.balanceOf(agentEoa)) / 1e6;

    const payRes = await fetch(`${BASE}/api/agents/${payerAgentId}/pay`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipientEoa, amount: AMOUNT }),
    });
    const payBody = await payRes.json();
    ok('POST pay: 200 with tx hash', payRes.status === 200 && /^0x[a-fA-F0-9]{64}$/.test(payBody.txHash ?? ''), `tx ${(payBody.txHash ?? '').slice(0, 12)}…`);

    // ── real balance deltas ───────────────────────────────────────────────
    const recvAfter = Number(await erc20.balanceOf(recipientEoa)) / 1e6;
    const recvDelta = recvAfter - recvBefore;
    ok('recipient credit == amount EXACTLY (native send, 1:1)', Math.abs(recvDelta - Number(AMOUNT)) < 0.000001,
      `credit ${recvDelta.toFixed(6)}`);

    const payerAfter = Number(await erc20.balanceOf(agentEoa)) / 1e6;
    const payerDebit = payerBefore - payerAfter;
    ok('payer debit == amount + gas only (NO transfer fee)', payerDebit >= Number(AMOUNT) && payerDebit < Number(AMOUNT) + 0.001,
      `debit ${payerDebit.toFixed(6)}`);

    const limitAfter = await getSpendLimitContract().getLimit(agentEoa);
    const spent = Number(limitAfter.spentInWindow) / 1e6;
    ok('spentInWindow == amount (on-chain spend record)', Math.abs(spent - Number(AMOUNT)) < 0.000001,
      `spent ${spent.toFixed(6)}`);

    const payLog = await prisma.paymentLog.findFirst({
      where: { reference: { startsWith: 'agentpay_' }, arcTxHash: payBody.txHash },
    });
    ok('PaymentLog SUCCESS row with real arcTxHash', !!payLog && payLog.status === 'SUCCESS',
      payLog ? `log ${payLog.reference}, hash ${(payLog.arcTxHash ?? '').slice(0, 12)}…` : 'no row');

    ok('API-reported recipient credit matches on-chain', payBody.recipientCredit === recvDelta.toFixed(6),
      `api ${payBody.recipientCredit}`);

    // ── over-cap rejection: spend-limit enforcement on the route ──────────
    const recvBefore2 = Number(await erc20.balanceOf(recipientEoa)) / 1e6;
    const overCapRes = await fetch(`${BASE}/api/agents/${payerAgentId}/pay`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipientEoa, amount: '1.90' }),
    });
    const overCapBody = await overCapRes.json();
    ok('over-cap pay: 403 spend-limit rejection', overCapRes.status === 403 && String(overCapBody.error ?? '').includes('spend limit'),
      `got ${overCapRes.status}: ${overCapBody.error ?? 'no error body'}`);
    const recvAfter2 = Number(await erc20.balanceOf(recipientEoa)) / 1e6;
    ok('over-cap: NO funds moved', Math.abs(recvAfter2 - recvBefore2) < 0.000001, `recipient delta ${(recvAfter2 - recvBefore2).toFixed(6)}`);
    const limitAfter2 = await getSpendLimitContract().getLimit(agentEoa);
    ok('over-cap: spentInWindow unchanged', Number(limitAfter2.spentInWindow) === Number(limitAfter.spentInWindow),
      `spent ${Number(limitAfter2.spentInWindow) / 1e6}`);
    ok('over-cap: no new PaymentLog row with that amount', !(await prisma.paymentLog.findFirst({
      where: { reference: { startsWith: 'agentpay_' }, amount: 1.9 },
    })));

    // ── wallet route is address-only (never leaks a key) ──────────────────
    ok('wallet response has no key material', !('privateKey' in walletBody) && !('encryptedKey' in walletBody));
  } finally {
    // cleanup: test agents + their wallets (payment logs kept as evidence)
    await prisma.x402EoaWallet.deleteMany({ where: { agentRegistryId: { in: [payerAgentId, recipientAgentId] } } });
    await prisma.agentRegistry.deleteMany({ where: { id: { in: [payerAgentId, recipientAgentId] } } });
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: originalHash } });
  }

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('agent-pay-e2e threw:', e?.message ?? e);
  process.exit(1);
});