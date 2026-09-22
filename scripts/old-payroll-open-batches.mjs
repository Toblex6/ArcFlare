// scripts/old-payroll-open-batches.mjs
//
// Focused READ-ONLY scan of the RETIRED payroll
//   0x67d2D2cA856bd22fDe121c90EE6AFB628BA7A6E3
// Prints ONLY non-Completed batches (the ones that could explain the stuck
// 0.333 USDC + 0.333 native), plus aggregate reconciliation. No transactions.
//
// Usage: node scripts/old-payroll-open-batches.mjs [rpcUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { ethers } from 'ethers';

const RPC = process.argv[2] || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const OLD_PAYROLL = '0x67d2D2cA856bd22fDe121c90EE6AFB628BA7A6E3';

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
      console.warn(`  (read retry ${i + 1}: ${String(e?.message ?? e).slice(0, 90)})`);
      await sleep(600 * (i + 1));
    }
  }
}

const provider = new ethers.JsonRpcProvider(RPC);
const payroll = new ethers.Contract(OLD_PAYROLL, PAYROLL_ABI, provider);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
const BSTATUS = ['None', 'Funded', 'Executing', 'Completed', 'Cancelled'];

const blockTag = await withRetry(() => provider.getBlockNumber());
const [bal, nat, next] = await Promise.all([
  withRetry(() => usdc.balanceOf(OLD_PAYROLL, { blockTag })),
  withRetry(() => provider.getBalance(OLD_PAYROLL, blockTag)),
  withRetry(() => payroll.nextBatchId()),
]);
console.log('blockTag:', blockTag, 'nextBatchId:', next.toString());
console.log(`contract USDC: ${bal.toString()}  native: ${nat.toString()}`);

let openCount = 0;
let unpaidOpenTotal = 0n;
const openMerchants = new Set();
for (let b = 0; b < Number(next); b++) {
  const batch = await withRetry(() => payroll.getBatch(b));
  if (Number(batch.status) === 3) continue; // Completed — nothing stuck
  openCount++;
  openMerchants.add(batch.merchant);
  const unpaid = batch.totalFunded - batch.totalPaidOut;
  unpaidOpenTotal += unpaid;
  console.log(`batch ${b}: ${BSTATUS[Number(batch.status)]}(${batch.status}) merchant=${batch.merchant} token=${batch.token}`);
  console.log(`  funded=${batch.totalFunded} paidOut=${batch.totalPaidOut} unpaid=${unpaid} recipients=${batch.recipientCount} createdAt=${batch.createdAt}`);
  const recipients = await withRetry(() => payroll.getBatchRecipients(b));
  for (const r of recipients) {
    const [amt, isPaid] = await Promise.all([
      withRetry(() => payroll.recipientAmounts(b, r)),
      withRetry(() => payroll.paid(b, r)),
    ]);
    console.log(`  - ${r} amount=${amt} paid=${isPaid}`);
  }
}
console.log('');
console.log(`open (non-Completed) batches: ${openCount}, total unpaid in open batches: ${unpaidOpenTotal}`);
console.log(`contract USDC balance: ${bal}  (open-unpaid ${unpaidOpenTotal} ${unpaidOpenTotal === bal ? '== balance ✓' : '!= balance — remainder is fee-dust/rounding'})`);
console.log('open-batch merchants:', [...openMerchants].join(', ') || '(none)');
console.log('SCAN DONE (no transactions sent).');
