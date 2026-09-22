// scripts/old-contracts-authority-proof.mjs
//
// READ-ONLY authority proof for the wind-down report:
//  1. Simulates (eth_call, no signature, no gas) the wind-down txs from every
//     address we DO hold keys for, proving none has authority on the old
//     contracts (all roles still point at the unavailable 0x0d9D… key).
//  2. Re-states final balances at a fixed blockTag.
//
// If any simulation SUCCEEDS unexpectedly, that path is actionable and the
// report conclusion changes — the script exits non-zero to flag it.
//
// Usage: node scripts/old-contracts-authority-proof.mjs [rpcUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { ethers } from 'ethers';

const RPC = process.argv[2] || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const OLD_ESCROW = '0xE1c8646a995e84bd6B81075D45cebd135Db822d8';
const OLD_PAYROLL = '0x67d2D2cA856bd22fDe121c90EE6AFB628BA7A6E3';
const OLD_KEY_ADDR = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';

// Every address we hold a key for in .env/.env.local (see winddown-inspect output).
const OURS = [
  '0x03BAdCDb102433798Df5feb854B87C7A37dde3A6', // new relayer (RELAYER/EOA/PRIVATE)
  '0x28B8358bFd037f37BcF54b6d9013FDF266b3b7B2', // buyer
  '0xc119bb61dCd7Ce422557485ecD17D679f44250a1', // seller
  '0x46dfEDe57338ceaD8c83C569fD37CE3A25746b35', // escrow admin
  '0xbD3FAD84e7a41D222c7C36947B0A3B1592F42154', // arc admin (= old treasury sink)
  '0x902C565bE31c146a79350387C1f77d6896814B58', // local arc admin
];

const ESCROW_IFACE = new ethers.Interface([
  'function releaseToWorkerFor(uint256 jobId) external',
  'function resolveDispute(uint256 jobId, uint256 workerBps, uint256 treasuryBps) external',
]);
const PAYROLL_IFACE = new ethers.Interface([
  'function executeBatch(uint256 batchId) external',
  'function cancelBatch(uint256 batchId) external',
]);
const ERC20_ABI = ['function balanceOf(address) external view returns (uint256)'];

const provider = new ethers.JsonRpcProvider(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

let surprise = 0;
async function expectRevert(label, to, data, from) {
  try {
    await withRetry(() => provider.call({ to, data, from }));
    console.log(`  !! ${label} from ${from} did NOT revert — ACTIONABLE PATH, investigate!`);
    surprise++;
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 90);
    console.log(`  ok (reverts as expected): ${label} from ${from.slice(0, 10)}… -> ${msg}`);
  }
}

console.log('--- authority simulations (eth_call only, zero gas, zero state change) ---');
for (const from of OURS) {
  if (from.toLowerCase() === OLD_KEY_ADDR.toLowerCase()) continue;
  await expectRevert('escrow.releaseToWorkerFor(4)', OLD_ESCROW, ESCROW_IFACE.encodeFunctionData('releaseToWorkerFor', [4]), from);
  await expectRevert('escrow.resolveDispute(4,10000,0)', OLD_ESCROW, ESCROW_IFACE.encodeFunctionData('resolveDispute', [4, 10000, 0]), from);
  await expectRevert('payroll.executeBatch(26)', OLD_PAYROLL, PAYROLL_IFACE.encodeFunctionData('executeBatch', [26]), from);
  await expectRevert('payroll.cancelBatch(26)', OLD_PAYROLL, PAYROLL_IFACE.encodeFunctionData('cancelBatch', [26]), from);
}

console.log('');
console.log('--- final balances (fixed blockTag) ---');
const blockTag = await withRetry(() => provider.getBlockNumber());
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
const [eU, eN, pU, pN] = await Promise.all([
  withRetry(() => usdc.balanceOf(OLD_ESCROW, { blockTag })),
  withRetry(() => provider.getBalance(OLD_ESCROW, blockTag)),
  withRetry(() => usdc.balanceOf(OLD_PAYROLL, { blockTag })),
  withRetry(() => provider.getBalance(OLD_PAYROLL, blockTag)),
]);
console.log(`blockTag ${blockTag}`);
console.log(`OLD escrow  ${OLD_ESCROW}: USDC=${eU} (${ethers.formatUnits(eU, 6)}) native=${eN} (${ethers.formatUnits(eN, 18)})`);
console.log(`OLD payroll ${OLD_PAYROLL}: USDC=${pU} (${ethers.formatUnits(pU, 6)}) native=${pN} (${ethers.formatUnits(pN, 18)})`);
if (surprise > 0) {
  console.log(`RESULT: ${surprise} UNEXPECTEDLY-AUTHORIZED path(s) — do not treat as fully stuck.`);
  process.exit(1);
} else {
  console.log('RESULT: no held key has any wind-down authority on either old contract (all simulations reverted).');
}
