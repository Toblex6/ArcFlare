// scripts/payroll-spendlimit-e2e.ts
//
// Spend-limit wiring E2E for the payroll funding path (Batch 5, item 5).
// Exercises the ACTUAL shipped modules:
//   - src/lib/agents/spendLimitEnforcer.ts (checkSpendAllowed pre-flight)
//   - src/lib/jobs/settlementRecovery.ts (race-window auto-refund)
//   - ArcFlareSpendLimit.sol on-chain enforcement (checkAndRecordSpend)
//   - ArcFlarePayroll.sol funding/execution/cancellation
//
// Run: npx tsx scripts/payroll-spendlimit-e2e.ts
//
// NOTE: no HTTP/402-signed-flow coverage here — that part goes through the
// dev server with a GatewayClient-signed payment (see telegram-deliver-e2e
// for the harness pattern). This script proves the enforcement + recovery
// mechanics the route relies on, with real funds and the real DB.

import "dotenv/config";
import { ethers } from "ethers";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { getUsdcAddress } from "@/lib/tokens/supportedTokens";
import { checkSpendAllowed, getSpendLimitContract } from "@/lib/agents/spendLimitEnforcer";
import { recoverFromSpendLimitRaceFailure } from "@/lib/jobs/settlementRecovery";
import { prisma } from "@/lib/prisma";

const RPC = process.argv[2] ?? "https://rpc.testnet.arc.network";
const provider = new ethers.JsonRpcProvider(RPC);
const PAYROLL = process.env.PAYROLL_CONTRACT_ADDRESS!;
const USDC = getUsdcAddress();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, info = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${info ? " — " + info : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? " — " + info : ""}`); }
};

const ERC20 = new ethers.Contract(USDC, [
  "function balanceOf(address) view returns (uint256)",
], provider);

const PAYROLL_ABI = [
  "function fundBatchFor(address merchant, address token, address[] recipients, uint256[] amounts) external returns (uint256 batchId)",
  "function executeBatch(uint256 batchId) external",
  "function cancelBatch(uint256 batchId) external",
  "function batches(uint256) view returns (tuple(address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount))",
  "function paid(uint256,address) view returns (bool)",
  "event BatchFunded(uint256 indexed batchId, address indexed merchant, address token, uint256 totalFunded, uint32 recipientCount)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const relayer = await getRelayerSigner();
  const merchant = await relayer.getAddress();
  const relayerProvider = new ethers.JsonRpcProvider(RPC);
  const relayerConnected = new ethers.Wallet((relayer as any).privateKey, relayerProvider);

  console.log(`── ArcFlarePayroll + SpendLimit E2E ─────────────────────────────`);
  console.log(`spend-limit contract : ${process.env.SPEND_LIMIT_CONTRACT_ADDRESS}`);
  console.log(`payroll contract     : ${PAYROLL}`);
  console.log(`merchant/relayer EOA : ${merchant}`);

  const eoaBefore = Number(await ERC20.balanceOf(merchant)) / 1e6;
  console.log(`\n[A] EOA USDC: ${eoaBefore.toFixed(4)}`);

  // ── B. on-chain limit configuration ──────────────────────────────────────
  console.log(`\n[B] set on-chain spend limit (2 USDC / 86400s window) ...`);
  const spendLimit = getSpendLimitContract();
  const limit = await spendLimit.getLimit(merchant);
  if (Number(limit.capPerWindow) > 0 && limit.active) {
    console.log(`  limit already set: cap ${Number(limit.capPerWindow) / 1e6} USDC / ${Number(limit.windowSeconds)}s, spent ${Number(limit.spentInWindow) / 1e6}`);
  } else {
    const tx = await spendLimit.setLimit(merchant, ethers.parseUnits("2", 6), 86400n);
    await tx.wait();
    console.log(`  setLimit tx ${tx.hash.slice(0, 12)} — cap 2 USDC/day`);
  }
  const afterSet = await spendLimit.getLimit(merchant);
  ok("limit active with cap 2 USDC", afterSet.active && Number(afterSet.capPerWindow) === 2_000_000, `spent ${Number(afterSet.spentInWindow) / 1e6}`);

  // ── C. pre-flight rejects an over-cap spend (before any funds move) ──────
  console.log(`\n[C] pre-flight over-cap rejection ...`);
  const overCap = await checkSpendAllowed({ agentAddress: merchant, amount: ethers.parseUnits("3", 6) });
  ok("checkSpendAllowed(3 USDC) rejected (cap 2)", !overCap.allowed, overCap.reason ?? "");
  const wouldExceed = await spendLimit.wouldExceedLimit(merchant, ethers.parseUnits("3", 6));
  ok("wouldExceedLimit(3 USDC) true on-chain", wouldExceed);

  // ── D. happy path: under-cap funding with the on-chain record ────────────
  console.log(`\n[D] under-cap funding: pre-flight → checkAndRecordSpend → fundBatchFor → execute ...`);
  const pre = await checkSpendAllowed({ agentAddress: merchant, amount: ethers.parseUnits("0.05", 6) });
  ok("pre-flight allows 0.05", pre.allowed, pre.reason ?? "ok");

  const recordTx = await spendLimit.checkAndRecordSpend(merchant, ethers.parseUnits("0.05", 6));
  await recordTx.wait();
  const afterRecord = await spendLimit.getLimit(merchant);
  ok("checkAndRecordSpend recorded 0.05 on-chain", Number(afterRecord.spentInWindow) === Number(afterSet.spentInWindow) + 50_000,
    `spent ${Number(afterRecord.spentInWindow) / 1e6}`);

  const payroll = new ethers.Contract(PAYROLL, PAYROLL_ABI, relayerConnected);
  const recipients = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
  const amounts = Array.from({ length: 3 }, () => ethers.parseUnits("0.01", 6));
  const usdc = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)"], relayerConnected);
  await (await usdc.approve(PAYROLL, amounts.reduce((a, b) => a + b, 0n))).wait();

  const fundTx = await payroll.fundBatchFor(merchant, USDC, recipients, amounts, { gasLimit: 4_000_000 });
  const fundReceipt = await fundTx.wait();
  const fundLog = (await payroll.queryFilter(payroll.filters.BatchFunded(), fundReceipt.blockNumber, fundReceipt.blockNumber))[0] as ethers.EventLog;
  const batchId = Number(fundLog.args[0]);
  ok("fundBatchFor mined (batch " + batchId + ")", fundReceipt.status === 1, `tx ${fundReceipt.hash.slice(0, 12)}`);

  const execTx = await payroll.executeBatch(batchId, { gasLimit: 4_000_000 });
  const execReceipt = await execTx.wait();
  const batch = await payroll.batches(batchId);
  ok("executeBatch → Completed(3)", Number(batch.status) === 3, `tx ${execReceipt.hash.slice(0, 12)}`);
  let allPaid = true;
  for (const r of recipients) {
    const paid = await payroll.paid(batchId, r);
    if (!paid) allPaid = false;
  }
  ok("all 3 recipients paid=true", allPaid);

  // ── E. cancel path (batch 2) ─────────────────────────────────────────────
  console.log(`\n[E] cancel path: fund small batch → cancel → refund lands ...`);
  const recC = Array.from({ length: 2 }, () => ethers.Wallet.createRandom().address);
  const amtC = Array.from({ length: 2 }, () => ethers.parseUnits("0.001", 6));
  await (await usdc.approve(PAYROLL, amtC.reduce((a, b) => a + b, 0n))).wait();
  const fundC = await payroll.fundBatchFor(merchant, USDC, recC, amtC, { gasLimit: 4_000_000 });
  const fundCReceipt = await fundC.wait();
  const fundCLog = (await payroll.queryFilter(payroll.filters.BatchFunded(), fundCReceipt.blockNumber, fundCReceipt.blockNumber))[0] as ethers.EventLog;
  const batchIdC = Number(fundCLog.args[0]);
  const balBeforeCancel = await ERC20.balanceOf(merchant);
  const cancelTx = await payroll.cancelBatch(batchIdC);
  await cancelTx.wait();
  const refundCredit = Number((await ERC20.balanceOf(merchant)) - balBeforeCancel) / 1e6;
  ok("cancel refund credited (any positive credit; inbound fee rate varies)", refundCredit > 0, `credit ${refundCredit.toFixed(4)} (event 0.002)`);

  // ── F. race-window recovery: record reverts after "settlement" → auto-refund ──
  console.log(`\n[F] race-window recovery (settle-then-revert) ...`);
  // Use a DEDICATED agent wallet (not the relayer EOA): the recovery refunds
  // from the relayer to the agent, and the real merchant is never the relayer.
  // Simulate the concurrent-spend race: spend 0.01, then drop the cap to the
  // current spent total — the next checkAndRecordSpend MUST revert, exactly
  // like a concurrent spend pushing the agent over cap between pre-flight
  // and the on-chain record.
  const agent = ethers.Wallet.createRandom().address;
  await (await spendLimit.setLimit(agent, ethers.parseUnits("2", 6), 86400n)).wait();
  await (await spendLimit.checkAndRecordSpend(agent, ethers.parseUnits("0.01", 6))).wait();
  const spentNow = BigInt((await spendLimit.getLimit(agent)).spentInWindow);
  await (await spendLimit.setLimit(agent, spentNow, 86400n)).wait();
  console.log(`  cap lowered to spent (${Number(spentNow) / 1e6}) — next record must revert`);

  const amount = ethers.parseUnits("0.01", 6);
  let recordReverted = false;
  let revertMessage = "";
  try {
    await spendLimit.checkAndRecordSpend(agent, amount);
  } catch (e: any) {
    recordReverted = true;
    revertMessage = e?.info?.error?.message ?? e?.message ?? "revert";
  }
  ok("checkAndRecordSpend reverts on over-cap (the race)", recordReverted, revertMessage.split("(")[0].slice(0, 60));

  const agentBalBefore = Number(await ERC20.balanceOf(agent)) / 1e6;
  const recoveryId = `e2e-race-${Date.now()}`;
  const { refundTxHash, recoveryId: rowId } = await recoverFromSpendLimitRaceFailure({
    agentAddress: agent,
    amount,
    jobCriteriaId: "payroll:3-recipients",
    gatewayRef: `sim-${recoveryId}`,
    settlementTxHash: `sim-${recoveryId}`,
    failureReason: revertMessage,
  });
  ok("recovery recorded + auto-refund mined", Boolean(refundTxHash), `tx ${refundTxHash.slice(0, 12)}`);

  await sleep(3000);
  const row = await prisma.stuckSettlement.findUnique({ where: { id: rowId } });
  ok("StuckSettlement row status REFUNDED", row?.status === "REFUNDED", `status ${row?.status} (id ${rowId})`);
  const agentBalAfter = Number(await ERC20.balanceOf(agent)) / 1e6;
  const credit = agentBalAfter - agentBalBefore;
  ok("refund landed on agent wallet (positive credit ≤ amount; inbound fee rate varies)",
    credit > 0 && credit <= 0.01, `credit ${credit.toFixed(4)}`);

  // Restore the cap for future runs.
  await spendLimit.setLimit(merchant, ethers.parseUnits("2", 6), 86400n);
  console.log("  cap restored to 2 USDC/day");

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
  console.log("✅ payroll spend-limit wiring verified on testnet");
}

main().catch((e) => { console.error("E2E threw:", e.message); process.exit(1); });
