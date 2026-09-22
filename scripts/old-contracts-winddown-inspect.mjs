// scripts/old-contracts-winddown-inspect.mjs
//
// READ-ONLY inspection of the RETIRED (pre-rotation, 2026-09-18) contracts:
//   OLD escrow  0xE1c8646a995e84bd6B81075D45cebd135Db822d8
//   OLD payroll 0x67d2D2cA856bd22fDe121c90EE6AFB628BA7A6E3
//
// Purpose: confirm (a) who still holds owner/arbiter/relayer roles on the old
// contracts, (b) per-job state on the old escrow, (c) per-batch state on the
// old payroll, (d) exact stuck balances (USDC 6-dec view + native 18-dec view
// at a FIXED blockTag so the two views can't be miscompared).
//
// NEVER prints private keys — only derived addresses. Makes NO transactions.
//
// Usage: node scripts/old-contracts-winddown-inspect.mjs [rpcUrl]
//
// Env: loads .env first, then .env.local with override (repo convention), but
// reports key-derived ADDRESSES per file separately so we can tell which file
// holds the OLD (compromised 0x0d9D…) key vs the NEW (0x03ba…) key.

import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC = process.argv[2] || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const OLD_ESCROW = '0xE1c8646a995e84bd6B81075D45cebd135Db822d8';
const OLD_PAYROLL = '0x67d2D2cA856bd22fDe121c90EE6AFB628BA7A6E3';

const ESCROW_ABI = [
  'function owner() external view returns (address)',
  'function arbiter() external view returns (address)',
  'function relayer() external view returns (address)',
  'function treasurySink() external view returns (address)',
  'function nextJobId() external view returns (uint256)',
  'function getJob(uint256 jobId) external view returns (tuple(address poster,address worker,address token,uint256 budget,bytes32 criteriaHash,uint8 status,uint64 fundedAt,uint64 assignedAt,uint8 maxRevisions,uint8 revisionCount))',
];
const PAYROLL_ABI = [
  'function owner() external view returns (address)',
  'function relayer() external view returns (address)',
  'function nextBatchId() external view returns (uint256)',
  'function getBatch(uint256 batchId) external view returns (tuple(address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount))',
  'function getBatchRecipients(uint256 batchId) external view returns (address[])',
  'function recipientAmounts(uint256 batchId, address recipient) external view returns (uint256)',
  'function paid(uint256 batchId, address recipient) external view returns (bool)',
];
const ERC20_ABI = ['function balanceOf(address) external view returns (uint256)'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      console.warn(`  (read retry ${i + 1}/${tries - 1}: ${String(e?.message ?? e).slice(0, 100)})`);
      await sleep(600 * (i + 1));
    }
  }
}

// Parse a dotenv file WITHOUT applying it — extract key-var values to derive
// addresses only (values never printed).
function addrsInFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  const lines = fs.readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(RELAYER_PRIVATE_KEY|PRIVATE_KEY|EOA_PRIVATE_KEY|BUYER_PRIVATE_KEY|SELLER_PRIVATE_KEY|ESCROW_ADMIN_PRIVATE_KEY|ARC_ADMIN_PRIVATE_KEY)\s*=\s*(\S+)\s*$/);
    if (!m) continue;
    try {
      out[`${path}:${m[1]}`] = new ethers.Wallet(m[2]).address;
    } catch {
      out[`${path}:${m[1]}`] = '(unparseable)';
    }
  }
  return out;
}

const provider = new ethers.JsonRpcProvider(RPC);
const escrow = new ethers.Contract(OLD_ESCROW, ESCROW_ABI, provider);
const payroll = new ethers.Contract(OLD_PAYROLL, PAYROLL_ABI, provider);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

const STATUS = ['None', 'Funded', 'Assigned', 'Submitted', 'Rejected', 'Released', 'Disputed', 'Resolved'];
const BSTATUS = ['None', 'Funded', 'Executing', 'Completed', 'Cancelled'];

console.log('RPC:', RPC);
const net = await withRetry(() => provider.getNetwork());
console.log('chainId:', net.chainId.toString());
console.log('');

// ---- key inventory (addresses only) ----
console.log('--- key-derived addresses (ADDRESSES ONLY, no secrets) ---');
for (const [k, v] of Object.entries({ ...addrsInFile('.env'), ...addrsInFile('.env.local') })) {
  console.log(`  ${k} -> ${v}`);
}
console.log('');

// ---- fixed blockTag for comparable balance views ----
const blockTag = await withRetry(() => provider.getBlockNumber());
console.log('blockTag for balance views:', blockTag);
console.log('');

// ---- old escrow roles ----
console.log('--- OLD escrow', OLD_ESCROW, '---');
const [eOwner, eArbiter, eRelayer, eSink, eNext] = await Promise.all([
  withRetry(() => escrow.owner()), 
  withRetry(() => escrow.arbiter()), withRetry(() => escrow.relayer()),
  withRetry(() => escrow.treasurySink()), withRetry(() => escrow.nextJobId()),
]);
console.log('  owner       :', eOwner);
console.log('  arbiter     :', eArbiter);
console.log('  relayer     :', eRelayer);
console.log('  treasurySink:', eSink);
console.log('  nextJobId   :', eNext.toString());

const [eUsdc, eNative] = await Promise.all([
  withRetry(() => usdc.balanceOf(OLD_ESCROW, { blockTag })),
  withRetry(() => provider.getBalance(OLD_ESCROW, blockTag)),
]);
console.log(`  USDC balanceOf : ${eUsdc.toString()} (${ethers.formatUnits(eUsdc, 6)} USDC)`);
console.log(`  native balance : ${eNative.toString()} (${ethers.formatUnits(eNative, 18)} native)`);
console.log('');
for (let j = 0; j < Number(eNext); j++) {
  const job = await withRetry(() => escrow.getJob(j));
  console.log(`  job ${j}: status=${STATUS[Number(job.status)] ?? '?'}(${job.status}) poster=${job.poster} worker=${job.worker}`);
  console.log(`          token=${job.token} budget=${job.budget.toString()} (${ethers.formatUnits(job.budget, 6)} USDC) maxRev=${job.maxRevisions} revCount=${job.revisionCount} fundedAt=${job.fundedAt} assignedAt=${job.assignedAt}`);
}
console.log('');

// ---- old payroll roles ----
console.log('--- OLD payroll', OLD_PAYROLL, '---');
const [pOwner, pRelayer, pNext] = await Promise.all([
  withRetry(() => payroll.owner()),
  withRetry(() => payroll.relayer()), withRetry(() => payroll.nextBatchId()),
]);
console.log('  owner       :', pOwner);
console.log('  relayer     :', pRelayer);
console.log('  nextBatchId :', pNext.toString());

const [pUsdc, pNative] = await Promise.all([
  withRetry(() => usdc.balanceOf(OLD_PAYROLL, { blockTag })),
  withRetry(() => provider.getBalance(OLD_PAYROLL, blockTag)),
]);
console.log(`  USDC balanceOf : ${pUsdc.toString()} (${ethers.formatUnits(pUsdc, 6)} USDC)`);
console.log(`  native balance : ${pNative.toString()} (${ethers.formatUnits(pNative, 18)} native)`);
console.log('');
for (let b = 0; b < Number(pNext); b++) {
  const batch = await withRetry(() => payroll.getBatch(b));
  console.log(`  batch ${b}: status=${BSTATUS[Number(batch.status)] ?? '?'}(${batch.status}) merchant=${batch.merchant}`);
  console.log(`          token=${batch.token} funded=${batch.totalFunded.toString()} paidOut=${batch.totalPaidOut.toString()} recipients=${batch.recipientCount}`);
  const recipients = await withRetry(() => payroll.getBatchRecipients(b));
  for (const r of recipients) {
    const [amt, isPaid] = await Promise.all([
      withRetry(() => payroll.recipientAmounts(b, r)),
      withRetry(() => payroll.paid(b, r)),
    ]);
    console.log(`          - ${r} amount=${amt.toString()} paid=${isPaid}`);
  }
}
console.log('');
console.log('INSPECT DONE (no transactions sent).');
