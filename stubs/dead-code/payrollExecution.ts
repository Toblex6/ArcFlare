/**
 * payrollExecution.ts
 *
 * Backend wiring for ArcFlarePayroll.sol. Single-party flow (merchant pays
 * own team) — simpler than job escrow since there's no counterparty-trust
 * problem, just: verify the merchant controls the funding wallet, settle
 * payment, fund the batch, execute payout.
 *
 * Spend-limit decision (Batch 4-5): payroll reuses the SAME spend-limit
 * layer as job funding (checkSpendAllowed pre-flight before settlement,
 * then checkAndRecordSpend on-chain + recordSpend after settlement, with
 * the race-window auto-refund from settlementRecovery). This is the safer,
 * consistent behavior — a compromised or automated merchant account is
 * bounded by the same on-chain per-address cap that agents are, and the
 * code path stays identical to x402JobPayment.ts so there's one less
 * divergence to reason about. The backend per-task/counterparty caps are
 * agent-specific and don't apply here (no taskId/counterparty is passed),
 * so only the on-chain cap layer engages — which is exactly the intent.
 */

import type { NextRequest } from "next/server";
import { withGateway } from "@/lib/x402"; // existing, untouched
import { verifyCallerControlsAddress } from "@/lib/auth/verifyCallerControlsAddress";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { checkSpendAllowed, recordSpend } from "@/lib/agents/spendLimitEnforcer";
import { recoverFromSpendLimitRaceFailure } from "@/lib/jobs/settlementRecovery";
import { getTokenBySymbol, isSupportedToken } from "@/lib/tokens/supportedTokens";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import { Contract } from "ethers";

const PAYROLL_CONTRACT_ADDRESS = process.env.PAYROLL_CONTRACT_ADDRESS ?? "";
const ARC_USDC_ADDRESS = getTokenBySymbol("USDC").address;

const PAYROLL_ABI = [
  "function fundBatchFor(address merchant, address token, address[] recipients, uint256[] amounts) external returns (uint256 batchId)",
  "function executeBatch(uint256 batchId) external",
  "function cancelBatch(uint256 batchId) external",
  "function getBatch(uint256 batchId) external view returns (tuple(address merchant,address token,uint256 totalFunded,uint256 totalPaidOut,uint8 status,uint64 createdAt,uint32 recipientCount))",
  "event BatchFunded(uint256 indexed batchId, address indexed merchant, address token, uint256 totalFunded, uint32 recipientCount)",
  "event BatchCompleted(uint256 indexed batchId, uint256 totalPaidOut)",
];

const SPEND_LIMIT_ABI = [
  "function checkAndRecordSpend(address agent, uint256 amount) external",
];

function getPayrollContract(): Contract {
  if (!PAYROLL_CONTRACT_ADDRESS) {
    throw new Error("PAYROLL_CONTRACT_ADDRESS is not configured — deploy ArcFlarePayroll.sol first");
  }
  return new Contract(PAYROLL_CONTRACT_ADDRESS, PAYROLL_ABI, getRelayerSigner());
}

function getSpendLimitContractForRecording(): Contract {
  const address = process.env.SPEND_LIMIT_CONTRACT_ADDRESS ?? "";
  if (!address) {
    throw new Error("SPEND_LIMIT_CONTRACT_ADDRESS is not configured — deploy ArcFlareSpendLimit.sol first");
  }
  return new Contract(address, SPEND_LIMIT_ABI, getRelayerSigner());
}

export interface PayrollRecipient {
  address: string;
  amount: bigint;
}

export interface FundPayrollParams {
  req: NextRequest;
  merchantAddress: string; // claimed; verified below
  recipients: PayrollRecipient[];
  token?: string; // defaults to USDC; pass EURC address once batch 5 lands
}

export interface FundPayrollResult {
  batchId: string;
  txHash: string;
  gatewayRef: string;
}

/**
 * Funds a payroll batch via x402 settlement, same pattern as job funding —
 * merchant doesn't need to hold gas or pre-approve the contract directly,
 * the relayer forwards the x402-settled amount into ArcFlarePayroll.
 */
export async function fundPayrollViaX402(params: FundPayrollParams): Promise<FundPayrollResult> {
  const { req, merchantAddress, recipients, token = ARC_USDC_ADDRESS } = params;

  if (recipients.length === 0) {
    throw new Error("payroll batch must have at least one recipient");
  }
  if (!isSupportedToken(token)) {
    throw new Error(`unsupported payroll token ${token} — see supportedTokens.ts`);
  }

  const callerCheck = await verifyCallerControlsAddress(req, merchantAddress, { role: "merchant" });
  if (!callerCheck.ok) {
    throw new Error(`caller verification failed: ${callerCheck.reason}`);
  }

  const totalAmount = recipients.reduce((sum, r) => sum + r.amount, BigInt(0));

  // Pre-flight spend check BEFORE settlement, so an over-cap merchant gets
  // a clean rejection instead of paying and then failing to fund the batch.
  // Mirrors fundJobViaX402 exactly (no taskId/counterparty here, so only
  // the on-chain per-address cap layer engages).
  const spendCheck = await checkSpendAllowed({
    agentAddress: callerCheck.resolvedAddress!,
    amount: totalAmount,
  });
  if (!spendCheck.allowed) {
    throw new Error(`payroll spend limit rejected (${spendCheck.rejectedBy}): ${spendCheck.reason}`);
  }

  const settlement = await withGateway({
    payerAddress: callerCheck.resolvedAddress!,
    tokenAddress: token,
    amount: totalAmount,
    memo: `payroll-batch:${recipients.length}-recipients`,
  });

  if (!settlement.success) {
    throw new Error(`x402 settlement failed: ${settlement.error ?? "unknown"}`);
  }

  // Post-settlement on-chain record. If a concurrent spend from the same
  // merchant pushed it over cap between pre-flight and now, this REVERTS
  // — the race-window auto-refund then returns the settled funds.
  const spendLimitContract = getSpendLimitContractForRecording();
  try {
    const spendTx = await spendLimitContract.checkAndRecordSpend(callerCheck.resolvedAddress, totalAmount);
    await spendTx.wait();
  } catch (spendLimitError) {
    const { refundTxHash, recoveryId } = await recoverFromSpendLimitRaceFailure({
      agentAddress: callerCheck.resolvedAddress!,
      amount: totalAmount,
      jobCriteriaId: `payroll:${recipients.length}-recipients`,
      gatewayRef: settlement.gatewayRef,
      settlementTxHash: settlement.txHash,
      failureReason: (spendLimitError as Error).message,
    });

    throw new Error(
      `payroll funding failed after settlement due to a spend-limit race — ` +
      `your payment of ${totalAmount} has been automatically refunded (tx: ${refundTxHash}). ` +
      `Recovery record: ${recoveryId}. Please retry once your spending window allows it.`
    );
  }

  await recordSpend({
    agentAddress: callerCheck.resolvedAddress!,
    amount: totalAmount,
  });

  const payroll = getPayrollContract();
  const addresses = recipients.map(r => r.address);
  const amounts = recipients.map(r => r.amount);

  const tx = await payroll.fundBatchFor(callerCheck.resolvedAddress, token, addresses, amounts);
  const receipt = await tx.wait();

  const batchId = extractBatchIdFromReceipt(receipt);

  return {
    batchId: batchId.toString(),
    txHash: receipt.hash,
    gatewayRef: settlement.gatewayRef,
  };
}

export async function executePayrollBatch(batchId: string): Promise<{ txHash: string }> {
  const payroll = getPayrollContract();
  const tx = await payroll.executeBatch(batchId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

function extractBatchIdFromReceipt(receipt: any): bigint {
  // Shared helper — BatchFunded.batchId is indexed, parseEventValue handles
  // indexed and non-indexed fields uniformly.
  return parseEventValue(receipt, PAYROLL_ABI, "BatchFunded", "batchId");
}