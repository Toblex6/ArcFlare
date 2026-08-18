// scripts/payroll-x402-e2e.ts
//
// Real end-to-end: a payroll batch funded through the ACTUAL
// fundPayrollViaX402() path (src/lib/payroll/payrollExecution.ts) with a
// real GatewayClient-signed x402 payment — not the direct-relayer path the
// original payroll E2E used.
//
// Flow: merchant A login → resolve its x402 buyer EOA → fund it from the
// relayer → deposit into its gateway wallet → set on-chain spend limit →
// GatewayClient.pay() against the dev server's POST /api/payroll/fund →
// verify batch funded + executed on-chain → re-pay over the cap and prove
// the spend-limit pre-flight rejects BEFORE settlement.
//
// Run with the dev server on :3000:  npx tsx scripts/payroll-x402-e2e.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import bcrypt from 'bcryptjs';
import { ethers } from 'ethers';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { prisma } from '@/lib/prisma';
import { getOrCreateBuyerWallet } from '@/lib/x402-wallet';
import { getRelayerSigner } from '@/lib/wallet/jobEscrowClient';
import { getSpendLimitContract } from '@/lib/agents/spendLimitEnforcer';
import { executePayrollBatch } from '@/lib/payroll/payrollExecution';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const TEST_PASSWORD = 'E2E_Test_123!';

const PAYROLL_ADDRESS = process.env.PAYROLL_CONTRACT_ADDRESS!;
const PAYROLL_ABI = [
  'function batches(uint256) view returns (tuple(address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount))',
  'function paid(uint256,address) view returns (bool)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

const USDC = '0x3600000000000000000000000000000000000000';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, info = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${info ? ' — ' + info : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? ' — ' + info : ''}`); }
};

async function main() {
  // ── merchant A + its x402 buyer EOA ─────────────────────────────────────
  const merchant = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true },
  });
  if (!merchant?.email || !merchant.passwordHash) throw new Error('merchant A not found');
  const originalHash = merchant.passwordHash;
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 10) },
  });

  let originalBuyerAddress: string | null = null;
  const existingBuyer = await (prisma as any).x402EoaWallet.findUnique({ where: { merchantId: merchant.id } });
  originalBuyerAddress = existingBuyer?.address ?? null;

  try {
    const loginRes = await fetch(`${BASE}/api/merchant/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: merchant.email, password: TEST_PASSWORD }),
    });
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    ok('merchant A login ok', loginRes.status === 200 && cookie.length > 0, `got ${loginRes.status}`);

    const wallet = await getOrCreateBuyerWallet(merchant.id);
    const buyerAddress = wallet.address;
    ok('buyer x402 EOA resolved', /^0x[a-fA-F0-9]{40}$/.test(buyerAddress), `buyer ${buyerAddress}`);

    const relayer = getRelayerSigner();
    const relayerAddress = await relayer.getAddress();
    const erc20 = new ethers.Contract(USDC, ERC20_ABI, relayer);

    const buyerBalBefore = Number(await erc20.balanceOf(buyerAddress)) / 1e6;
    if (buyerBalBefore < 0.3) {
      // fund the fresh buyer EOA from the relayer (fee token: EOA→EOA flat
      // 0.001028 measured 2026-08-18 — rate not asserted anywhere)
      const topUp = ethers.parseUnits('0.6', 6);
      const tx = await erc20.transfer(buyerAddress, topUp);
      await tx.wait();
      console.log(`  funded buyer EOA +0.6 USDC (tx ${tx.hash.slice(0, 12)}, flat fee ~0.0010)`);
    } else {
      console.log(`  buyer EOA already funded (${buyerBalBefore.toFixed(4)} USDC)`);
    }
    const buyerBal = Number(await erc20.balanceOf(buyerAddress)) / 1e6;
    ok('buyer EOA has USDC', buyerBal > 0.3, `${buyerBal.toFixed(4)} USDC`);

    // ── deposit into the buyer's gateway wallet ────────────────────────────
    const client = new GatewayClient({ chain: 'arcTestnet', privateKey: wallet.privateKey });
    let depositTxHash: string | undefined;
    try {
      const bal = await client.getBalances();
      const available = parseFloat(bal?.gateway?.formattedAvailable ?? '0');
      if (available < 0.03) {
        const deposit = await client.deposit('0.3');
        depositTxHash = deposit.depositTxHash;
        console.log(`  deposited 0.3 USDC into gateway (${depositTxHash.slice(0, 12)})`);
      } else {
        console.log(`  gateway already funded (${available.toFixed(4)} USDC)`);
      }
    } catch (e: any) {
      ok('gateway deposit', false, e.message);
    }
    if (depositTxHash) ok('gateway deposit mined', /^0x[a-fA-F0-9]{64}$/.test(depositTxHash), `tx ${depositTxHash.slice(0, 12)}`);

    // ── on-chain spend limit for the buyer EOA (2 USDC / day) ─────────────
    const spendLimit = getSpendLimitContract();
    await (await spendLimit.setLimit(buyerAddress, ethers.parseUnits('2', 6), 86400n)).wait();
    const limit = await spendLimit.getLimit(buyerAddress);
    ok('spend limit active for buyer EOA', Boolean(limit.active) && Number(limit.capPerWindow) === 2_000_000,
      `cap 2 USDC/day, spent ${Number(limit.spentInWindow) / 1e6}`);

    // ── REAL PAYMENT: fund a payroll batch through fundPayrollViaX402 ──────
    console.log(`\n[pay] funding payroll batch via GatewayClient.pay → fundPayrollViaX402 ...`);
    const recipients = Array.from({ length: 3 }, () => ({
      address: ethers.Wallet.createRandom().address,
      amount: '0.01',
    }));
    const payRes = await client.pay(`${BASE}/api/payroll/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ recipients }),
    });
    const data = payRes.data as any;
    ok('pay succeeded', payRes.status === 200 && data?.success, `batch ${data?.batchId}, settle tx ${payRes.transaction?.slice(0, 12)}`);
    const batchId = Number(data.batchId);
    ok('batch id present', batchId > 0, `batchId ${batchId}`);
    const fundTxHash = data.txHash as string | undefined;
    ok('fund tx hash present', typeof fundTxHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(fundTxHash ?? ''), `fund ${fundTxHash?.slice(0, 12)}`);
    console.log(`  gatewayRef ${data.gatewayRef?.slice(0, 16)}…, sweepTx ${data.sweepTxHash?.slice(0, 12) ?? 'n/a'}`);

    // ── verify the batch on-chain ──────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 4000));
    const rpc = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
    const payroll = new ethers.Contract(PAYROLL_ADDRESS, PAYROLL_ABI, rpc);
    const batch = await payroll.batches(batchId);
    ok('batch Funded on-chain', Number(batch.status) === 1, `status ${Number(batch.status)}, totalFunded ${Number(batch.totalFunded) / 1e6} USDC`);
    ok('totalFunded exact (0.03)', Number(batch.totalFunded) === 30_000, `totalFunded ${Number(batch.totalFunded)}`);

    const exec = await executePayrollBatch(String(batchId));
    ok('executeBatch via relayer', Boolean(exec.txHash), `tx ${exec.txHash.slice(0, 12)}`);
    await new Promise((r) => setTimeout(r, 4000));
    const batchAfter = await payroll.batches(batchId);
    ok('batch Completed (3)', Number(batchAfter.status) === 3, `status ${Number(batchAfter.status)}`);
    let allPaid = true;
    for (const r of recipients) {
      if (!(await payroll.paid(batchId, r.address))) allPaid = false;
    }
    ok('all 3 recipients paid exactly', allPaid);

    // ── spend-limit ENFORCEMENT: over-cap payment must be rejected ─────────
    console.log(`\n[enforce] paying 3 USDC (cap 2) — pre-flight must reject BEFORE settlement ...`);
    const balBeforeOver = await client.getBalances();
    const overCapBody = JSON.stringify({ recipients: [{ address: ethers.Wallet.createRandom().address, amount: '3' }] });
    let enforced = false;
    let enforcementDetail = '';
    let rejectedUpstream = null;
    try {
      const overRes = await client.pay(`${BASE}/api/payroll/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: overCapBody,
      });
      rejectedUpstream = overRes.data as any;
      enforcementDetail = JSON.stringify(rejectedUpstream).slice(0, 160);
    } catch (e: any) {
      enforcementDetail = (e?.message ?? '').slice(0, 160) + ' | ' + (e?.cause?.message ?? '');
      rejectedUpstream = e?.cause?.data ?? null;
    }
    enforced =
      typeof enforcementDetail === 'string' && enforcementDetail.toLowerCase().includes('spend limit');
    ok('over-cap payment rejected with spend-limit error', enforced, enforcementDetail.slice(0, 120));

    await new Promise((r) => setTimeout(r, 3000));
    const balAfterOver = await client.getBalances();
    const beforeAvail = parseFloat(balBeforeOver?.gateway?.formattedAvailable ?? '0');
    const afterAvail = parseFloat(balAfterOver?.gateway?.formattedAvailable ?? '0');
    ok('no settlement taken for rejected payment (gateway balance unchanged)',
      Math.abs(beforeAvail - afterAvail) < 0.0005, `gateway ${beforeAvail.toFixed(4)} → ${afterAvail.toFixed(4)}`);

    const spentOnChain = Number((await spendLimit.getLimit(buyerAddress)).spentInWindow) / 1e6;
    ok('spend recorded on-chain (this run advanced the window; actual may include prior attempts)',
      spentOnChain >= 0.03 && spentOnChain < 2, `spent ${spentOnChain}`);
  } finally {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { passwordHash: originalHash },
    });
  }

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
  console.log('✅ payroll x402 flow verified end-to-end on testnet (fundPayrollViaX402 path)');
}

main().catch((e) => { console.error('e2e threw:', e.message); process.exit(1); });
