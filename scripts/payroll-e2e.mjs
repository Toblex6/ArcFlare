// scripts/payroll-e2e.mjs
// REAL testnet E2E for ArcFlarePayroll.sol (deployed at PAYROLL_CONTRACT_ADDRESS):
//   A. fund the relayer EOA with testnet USDC via Circle (same transferUsdc path as Telegram)
//   B. gas measurement: fund + execute a 15-recipient batch, measure gasUsed, extrapolate to 200
//   C. balance assertions on every recipient (before/after), contract escrow, paid flags
//   D. retry-safety: re-execute a Completed batch -> revert, no double payment
//   E. atomicity: execute with a starvation gas limit -> full revert (no partial payment),
//      then full-gas retry -> completes (the paid-mapping retry path)
//   F. cancelBatch: full refund to merchant, then cancel-on-Completed -> revert
//
// Usage: node scripts/payroll-e2e.mjs [rpcUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { ethers } from 'ethers';

const RPC = process.argv[2] || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const PAYROLL = process.env.PAYROLL_CONTRACT_ADDRESS || '';
const USDC = '0x3600000000000000000000000000000000000000';

const MERCHANT_KEY = process.env.RELAYER_PRIVATE_KEY || '';
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';

const provider = new ethers.JsonRpcProvider(RPC);

// RPC resilience: Arc testnet providers intermittently reset node TLS
// connections (ECONNRESET / bad record MAC) and QuickNode free tier returns
// -32011 "request limit reached". Retry transient errors with backoff at the
// transport level so the whole suite (every eth_call/eth_getBalance) benefits.
{
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await origSend(method, params);
      } catch (e) {
        const msg = String(e?.message ?? e);
        const infoCode = String(e?.info?.error?.code ?? e?.error?.code ?? '');
        const retriable =
          msg.includes('limit reached') || msg.includes('ECONNRESET') ||
          msg.includes('TIMEOUT') || msg.includes('bad record mac') ||
          msg.includes('request timeout') || msg.includes('connection') ||
          msg.includes('socket') || infoCode.includes('-32011') ||
          infoCode.includes('-32005') || infoCode.includes('429');
        if (!retriable || attempt >= 6) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  };
}

const merchant = new ethers.Wallet(MERCHANT_KEY, provider);
const MERCHANT_ADDR = merchant.address;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const PAYROLL_ABI = [
  'function fundBatchFor(address merchant,address token,address[] recipients,uint256[] amounts) returns (uint256)',
  'function executeBatch(uint256)',
  'function cancelBatch(uint256)',
  'function getBatch(uint256) view returns (tuple(address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount))',
  'function batches(uint256) view returns (address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount)',
  'function paid(uint256,address) view returns (bool)',
  'function batchRecipients(uint256,uint256) view returns (address)',
  'function recipientCount(uint256) view returns (uint32)',
  'event BatchFunded(uint256 indexed batchId,address indexed merchant,address token,uint256 totalFunded,uint32 recipientCount)',
  'event RecipientPaid(uint256 indexed batchId,address indexed recipient,uint256 amount)',
  'event BatchCompleted(uint256 indexed batchId,uint256 totalPaidOut)',
  'event BatchCancelled(uint256 indexed batchId,uint256 refundedAmount)',
];

const usdc = new ethers.Contract(USDC, ERC20_ABI, merchant);
const payroll = new ethers.Contract(PAYROLL, PAYROLL_ABI, merchant);
const iface = new ethers.Interface(PAYROLL_ABI);

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ❌ ${name} — ${detail}`); }
}

const usdc6 = (n) => ethers.parseUnits(String(n), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Block-pinned balance read: eth_call at an explicit block number, after a
// short settle delay — avoids load-balanced RPC replica skew / reorg drift
// between tx.wait() and the balance check.
async function balAt(addr, block) {
  await sleep(1500);
  return usdc.balanceOf(addr, { blockTag: block });
}

// batchId extraction — same real event-log pattern as parseEventValue /
// extractBatchIdFromReceipt (scan receipt logs, parse, read the field)
function extractBatchId(receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== 'BatchFunded') continue;
      return BigInt(parsed.args.batchId);
    } catch { continue; }
  }
  throw new Error('BatchFunded event not found in receipt');
}

async function waitForCircleTx(txId) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`https://api.circle.com/v1/transactions/${txId}`, {
      headers: { Authorization: 'Bearer ' + process.env.CIRCLE_API_KEY },
    });
    const d = await res.json();
    const t = d.data?.transaction;
    if (t?.onchainHash) return t.onchainHash;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Circle transfer did not produce an onchain hash in time');
}

async function main() {
  console.log('── ArcFlarePayroll REAL E2E ───────────────────────────────');
  if (!PAYROLL) { console.log('❌ PAYROLL_CONTRACT_ADDRESS not set'); process.exitCode = 1; return; }
  console.log('contract:', PAYROLL);
  console.log('merchant/relayer EOA:', MERCHANT_ADDR);

  // ── A. fund the EOA with testnet USDC via Circle (same path as Telegram) ─
  const eoaBefore = Number(await usdc.balanceOf(MERCHANT_ADDR)) / 1e6;
  if (eoaBefore < 0.16) {
    console.log(`\n[A] funding EOA with 0.20 USDC from Circle wallet (have ${eoaBefore.toFixed(4)}) ...`);
    const res = await fetch('https://api.circle.com/v1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CIRCLE_API_KEY },
      body: JSON.stringify({
        walletId: DEFAULT_PAYER_WALLET_ID,
        destinationAddress: MERCHANT_ADDR,
        amounts: [{ amount: '0.20', currency: 'USDC' }],
        blockchain: 'ARC-TESTNET',
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      }),
    });
    const d = await res.json();
    if (!d.data?.id) throw new Error('Circle transfer rejected: ' + JSON.stringify(d).slice(0, 200));
    const txHash = await waitForCircleTx(d.data.id);
    const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
    ok('Circle USDC funding tx mined', receipt.status === 1, `tx ${txHash}`);
  } else {
    console.log(`\n[A] EOA already has ${eoaBefore.toFixed(4)} USDC — skipping funding`);
  }
  const eoaAfter = Number(await usdc.balanceOf(MERCHANT_ADDR)) / 1e6;
  ok('EOA holds ≥0.16 USDC for tests', eoaAfter >= 0.16, `balance ${eoaAfter.toFixed(4)}`);

  const blockLimit = Number((await provider.getBlock('latest')).gasLimit);
  console.log(`\n  Arc Testnet block gas limit: ${blockLimit}`);

  // ── B. GAS TEST: 15-recipient batch ─────────────────────────────────────
  console.log('\n[B] gas measurement — 15-recipient batch ...');
  const N = 15;
  const recipients = Array.from({ length: N }, () => ethers.Wallet.createRandom().address);
  const amounts = Array.from({ length: N }, () => usdc6(0.01));
  const total = amounts.reduce((a, b) => a + b, 0n);
  const eoaBalBefore = await usdc.balanceOf(MERCHANT_ADDR);
  const contractBalBefore = await usdc.balanceOf(PAYROLL);
  const recBalsBefore = [];
  for (const r of recipients) recBalsBefore.push(await usdc.balanceOf(r));
  const beforeBlock = (await provider.getBlockNumber()) - 2;

  const approveTx = await usdc.approve(PAYROLL, total);
  await approveTx.wait();
  const fundTx = await payroll.fundBatchFor(MERCHANT_ADDR, USDC, recipients, amounts, { gasLimit: 4_000_000 });
  const fundReceipt = await fundTx.wait();
  const gasBatchId = extractBatchId(fundReceipt);
  ok('fundBatchFor emitted BatchFunded, real batchId parsed from event log', Number(gasBatchId) >= 0, `batchId ${gasBatchId}`);
  console.log(`  batchId ${gasBatchId}  fund tx ${fundReceipt.hash}  gasUsed ${fundReceipt.gasUsed}`);

  const afterBlock = fundReceipt.blockNumber;
  const eoaBalAfterFund = await balAt(MERCHANT_ADDR, afterBlock);
  const fundDebit = Number(eoaBalBefore - eoaBalAfterFund) / 1e6;
  const fundFee = fundDebit - Number(total) / 1e6;
  // Arc testnet USDC charges per-target fees (rate varies by target address
  // and schedule — measured 2026-08-18: EOA->EOA flat 0.001028, EOA->contract
  // 0.0022..0.0044 for the swap pool but ~12% for this payroll contract).
  // Do NOT assert a fee band here — the real invariant is checked next line
  // (escrow holds the EXACT total regardless of what the EOA was debited).
  ok('EOA debited total + token fees (any non-negative fee)', fundFee >= 0, `debit ${fundDebit.toFixed(4)} (total ${Number(total)/1e6}, fee ${fundFee.toFixed(4)})`);
  console.log(`  [fee-obs] fund-tx fee: ${fundFee.toFixed(4)} (approve+transfer+contract-bound)`);
  ok('contract escrow holds total', (await balAt(PAYROLL, afterBlock)) === contractBalBefore + total);

  const execTx = await payroll.executeBatch(gasBatchId, { gasLimit: 4_000_000 });
  const execReceipt = await execTx.wait();
  const execBlock = execReceipt.blockNumber;
  const gasUsed = execReceipt.gasUsed;
  console.log(`  execute tx ${execReceipt.hash}  gasUsed ${gasUsed}`);

  // ── C. balance + state assertions ───────────────────────────────────────
  console.log('\n[C] per-recipient balance assertions ...');
  let allPaid = true;
  for (let i = 0; i < N; i++) {
    const bal = await balAt(recipients[i], execBlock);
    const expected = recBalsBefore[i] + amounts[i];
    const paidFlag = await payroll.paid(gasBatchId, recipients[i]);
    if (bal !== expected || !paidFlag) allPaid = false;
    if (i < 3) console.log(`    recipient ${i}: +${Number(amounts[i]) / 1e6} USDC (paid=${paidFlag})`);
  }
  ok('all 15 recipients received exactly their amounts', allPaid);
  ok('escrow drained after execution', (await balAt(PAYROLL, execBlock)) === contractBalBefore);
  const batch = await payroll.batches(gasBatchId);
  ok('batch status = Completed (3)', Number(batch.status) === 3, `status ${batch.status}`);
  ok('totalPaidOut = total', batch.totalPaidOut === total);

  // ── D. retry-safety: re-execute must revert, no double payment ──────────
  console.log('\n[D] retry-safety ...');
  let reexecReverted = false;
  try {
    await payroll.executeBatch(gasBatchId);
  } catch { reexecReverted = true; }
  ok('re-execute Completed batch reverts', reexecReverted);
  let doublePaid = false;
  for (const r of recipients) {
    const idx = recipients.indexOf(r);
    const bal = await usdc.balanceOf(r);
    if (bal > recBalsBefore[idx] + amounts[idx]) doublePaid = true;
  }
  ok('no recipient balance moved on re-execute (no double payment)', !doublePaid);

  // ── E. atomicity: gas-starved execute reverts fully, retry completes ────
  console.log('\n[E] atomicity + retry from Funded ...');
  const rec3 = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
  const amt3 = [usdc6(0.001), usdc6(0.001), usdc6(0.001)];
  const total3 = amt3.reduce((a, b) => a + b, 0n);
  await (await usdc.approve(PAYROLL, total3)).wait();
  const f3 = await payroll.fundBatchFor(MERCHANT_ADDR, USDC, rec3, amt3, { gasLimit: 4_000_000 });
  const batchId3 = extractBatchId(await f3.wait());
  const bal3Before = [];
  for (const r of rec3) bal3Before.push(await usdc.balanceOf(r));
  const before3Block = (await provider.getBlockNumber()) - 2;

  let starvedReverted = false;
  let starvedHash = '';
  try {
    const starved = await payroll.executeBatch(batchId3, { gasLimit: 120_000 });
    const r = await starved.wait();
    starvedHash = r.hash;
  } catch { starvedReverted = true; }
  console.log(`  starved-execute ${starvedHash ? 'MINED ' + starvedHash : 'reverted'}`);
  ok('gas-starved execute reverts (no partial payment)', starvedReverted);
  await sleep(3000);
  const afterStarve = await payroll.batches(batchId3);
  ok('batch still Funded (1) after revert', Number(afterStarve.status) === 1, `status ${afterStarve.status}`);
  let untouched = true;
  for (let i = 0; i < 3; i++) if ((await balAt(rec3[i], afterStarve && (await provider.getBlockNumber()))) !== bal3Before[i]) untouched = false;
  ok('no recipient paid during reverted tx', untouched);

  const retryTx = await payroll.executeBatch(batchId3, { gasLimit: 4_000_000 });
  const retryReceipt = await retryTx.wait();
  const afterRetry = await payroll.batches(batchId3);
  let all3Paid = true;
  for (let i = 0; i < 3; i++) if ((await balAt(rec3[i], retryReceipt.blockNumber)) !== bal3Before[i] + amt3[i]) all3Paid = false;
  ok('full-gas retry pays all 3 (paid-mapping retry path works)', all3Paid && Number(afterRetry.status) === 3, `status ${afterRetry.status}`);

  // ── F. cancelBatch: refund to merchant ──────────────────────────────────
  console.log('\n[F] cancelBatch refund ...');
  const recC = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
  const amtC = [usdc6(0.001), usdc6(0.001), usdc6(0.001)];
  const totalC = amtC.reduce((a, b) => a + b, 0n);
  await (await usdc.approve(PAYROLL, totalC)).wait();
  const eoaBalBeforeCancel = await usdc.balanceOf(MERCHANT_ADDR);
  const fC = await payroll.fundBatchFor(MERCHANT_ADDR, USDC, recC, amtC, { gasLimit: 4_000_000 });
  const batchIdC = extractBatchId(await fC.wait());
  ok('cancel batch escrow holds total', (await usdc.balanceOf(PAYROLL)) === contractBalBefore + totalC);
  const eoaBalJustBeforeCancel = await usdc.balanceOf(MERCHANT_ADDR);

  const cancelTx = await payroll.cancelBatch(batchIdC);
  const cancelReceipt = await cancelTx.wait();
  const refundDelta = Number((await balAt(MERCHANT_ADDR, cancelReceipt.blockNumber)) - eoaBalJustBeforeCancel) / 1e6;
  // The token eats an inbound fee on the credit (rate varies — measured
  // 0.0014 for 0.003). Do NOT assert a band; the exact invariant is the
  // escrow-empty check below, this just confirms the merchant got credit.
  ok('merchant received refund (any positive credit)', refundDelta > 0, `credit ${refundDelta.toFixed(4)}`);
  console.log(`  [fee-obs] cancel-refund credit: ${refundDelta.toFixed(4)} (tx ${cancelReceipt.hash.slice(0,12)}, event amount 0.003)`);
  ok('escrow empty after cancel', (await usdc.balanceOf(PAYROLL)) === contractBalBefore);
  const cancelled = await payroll.batches(batchIdC);
  ok('batch status = Cancelled (4)', Number(cancelled.status) === 4, `status ${cancelled.status}`);

  let cancelCompletedReverted = false;
  try { await payroll.cancelBatch(gasBatchId); } catch { cancelCompletedReverted = true; }
  ok('cancel on Completed batch reverts', cancelCompletedReverted);

  // ── G. report gas numbers + extrapolation ───────────────────────────────
  console.log('\n[G] gas numbers ...');
  const perRecipient = Math.round((Number(gasUsed) - 21_000) / N);
  const est200 = 21_000 + perRecipient * 200;
  console.log(`  15-recipient execute gasUsed : ${gasUsed} (block limit ${blockLimit})`);
  console.log(`  est per-recipient            : ${perRecipient}`);
  console.log(`  est 200-recipient            : ${est200} (block limit ${blockLimit})`);
  ok(`200-recipient extrapolation ${est200} < block limit ${blockLimit}`, est200 < blockLimit, `${est200} vs ${blockLimit}`);

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('✅ payroll contract fully verified on testnet');
  }
}

main().catch((e) => { console.error('E2E threw:', e); process.exit(1); });