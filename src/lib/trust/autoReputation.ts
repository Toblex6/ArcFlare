// src/lib/trust/autoReputation.ts
// Auto-reputation from validated completion: validation PASS -> escrow release -> reputation signal.
// Uses ERC-8004 ReputationRegistry.giveFeedback, same as /api/agent/reputation but with deterministic
// dedupe key (jobId + validationId + eventType) following AgentLedgerEntry.dedupeKey convention.
// Awaited at authoritative point (complete route) — no setTimeout, no unguarded .catch() fire-and-forget.

import { prisma } from "@/lib/prisma";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { keccak256, toHex } from "viem";

const REPUTATION_REGISTRY = (process.env.REPUTATION_REGISTRY_ADDRESS || "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`;

// Deterministic dedupe: jobId:validationId:VALIDATED_COMPLETION
// We also persist a guard row via AgentLedgerEntry with type REPUTATION_SIGNAL so retries are idempotent.
export function buildReputationDedupeKey(jobId: bigint, validationId: string): string {
  return `${jobId.toString()}:${validationId}:VALIDATED_COMPLETION`;
}

export async function maybeAutoReputationForValidatedJob(params: {
  jobId: bigint;
  providerAgentId: number | null;
  providerTokenId: string | null;
  jobValidationId: string | null;
  txHash: string;
}): Promise<{ attempted: boolean; txHash?: string; deduped?: boolean; reason?: string }> {
  const { jobId, providerAgentId, providerTokenId, jobValidationId, txHash } = params;
  if (!jobValidationId || !providerAgentId || !providerTokenId) {
    return { attempted: false, reason: "missing jobValidationId/providerAgentId/providerTokenId" };
  }
  const validation: any = await (prisma as any).erc8183JobValidation.findUnique({ where: { id: jobValidationId } }).catch(() => null);
  if (!validation) return { attempted: false, reason: "validation not found" };
  if (validation.status !== "PASSED") return { attempted: false, reason: `validation status ${validation.status} != PASSED` };

  // Dedupe guard: check if we already emitted for this job+validation
  // Use a synthetic ledger entry type so the existing unique dedupeKey handles it
  const dedupeKey = buildReputationDedupeKey(jobId, jobValidationId);
  // Probe via prisma raw or ledger table
  try {
    const existing = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey } }).catch(() => null);
    if (existing) return { attempted: true, deduped: true, reason: "already recorded" };
  } catch {}

  // Read job to get validator vs provider vs client for self-feedback exclusion
  const job: any = await (prisma as any).erc8183Job.findUnique({ where: { jobId } }).catch(() => null);
  if (job) {
    const providerSca = String(job.providerSCA || "").toLowerCase();
    const clientSca = String(job.clientSCA || "").toLowerCase();
    const validatorSca = String(validation.validatorSCA || "").toLowerCase();
    // Self-feedback: validator == provider (should not happen due to hire guard, but check)
    if (validatorSca && providerSca && validatorSca === providerSca) {
      return { attempted: false, reason: "self-feedback: validator is provider" };
    }
    // Self-hiring: provider == client => not positive evidence
    if (providerSca && clientSca && providerSca === clientSca) {
      return { attempted: false, reason: "self-hiring: provider is client" };
    }
  }

  // Idempotency: claim the dedupeKey via a ledger placeholder BEFORE the on-chain write (same pattern as PaymentLog idempotencyKey)
  // We use REPUTATION_SIGNAL placeholder with amount 0 so a concurrent caller loses P2002
  try {
    await (prisma as any).agentLedgerEntry.create({
      data: {
        agentRegistryId: providerAgentId,
        type: "REPUTATION_SIGNAL",
        amount: "0",
        token: "USDC",
        direction: "CREDIT",
        jobId,
        jobValidationId,
        txHash: null,
        dedupeKey,
        description: `validated completion reputation guard for job ${jobId}`,
        metadata: { phase: "guard", providerTokenId },
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return { attempted: true, deduped: true, reason: "concurrent guard won" };
    // non-unique error => continue, but log
    console.warn("[autoReputation] guard create failed:", e?.message);
  }

  // Resolve validator wallet: must use the validator's Circle wallet to sign giveFeedback.
  // Find agent for validator SCA to get circleWalletId, fallback to env validator if not found but SCA matches env.
  let validatorWalletId: string | null = null;
  let validatorSCA: string = validation.validatorSCA;
  try {
    const validatorAgent: any = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: validatorSCA, mode: "insensitive" } }, select: { scaAddress: true, circleWalletId: true } });
    if (validatorAgent?.circleWalletId) validatorWalletId = validatorAgent.circleWalletId;
  } catch {}
  // Fallback: if validator matches configured validator env and we have its walletId, use it
  if (!validatorWalletId) {
    const envValidator = process.env.AGENT_VALIDATOR_WALLET_ADDRESS;
    const envValidatorId = process.env.AGENT_VALIDATOR_WALLET_ID;
    if (envValidator && validatorSCA.toLowerCase() === envValidator.toLowerCase() && envValidatorId) {
      validatorWalletId = envValidatorId;
    }
  }
  if (!validatorWalletId) {
    // Try to resolve via Circle wallet address directly (getWallet not needed — we need wallet ID to sign)
    // We have validatorSCA but not walletId; try to find CircleWallet row by address
    try {
      const cw: any = await (prisma as any).circleWallet.findFirst({ where: { address: { equals: validatorSCA, mode: "insensitive" } }, select: { walletId: true } });
      if (cw?.walletId) validatorWalletId = cw.walletId;
    } catch {}
  }
  if (!validatorWalletId) {
    // Can't sign without walletId — leave guard row as failed attempt marker? Remove guard so retry can succeed when wallet is available?
    // Keep guard but update metadata to indicate missing wallet, so next retry with wallet will dedupe incorrectly.
    // Instead, delete guard so future retry can proceed.
    try { await (prisma as any).agentLedgerEntry.delete({ where: { dedupeKey } }).catch(() => {}); } catch {}
    return { attempted: false, reason: "validator wallet not resolvable" };
  }

  // On-chain write: giveFeedback(tokenId, score 100, 0, tag, "", "", "", feedbackHash)
  // Use score 100 for validated-completion PASS (strong positive); tag includes jobId for uniqueness.
  const circleClient = getCircleClient();
  const tag = `validated-completion:${jobId.toString()}`;
  const feedbackHash = keccak256(toHex(tag)) as `0x${string}`;
  const score = 100;
  try {
    // Resolve SCA for signing: getWallet to confirm address
    const w = await circleClient.getWallet({ id: validatorWalletId });
    const signingAddress = (w as any).data?.wallet?.address || validatorSCA;
    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress: signingAddress,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: REPUTATION_REGISTRY,
      abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      abiParameters: [String(providerTokenId), String(score), "0", tag, "", "", "", feedbackHash],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txId = (tx as any).data?.id;
    if (!txId) throw new Error("no tx id from Circle");
    const onChainTxHash = await waitForTransaction(txId, `auto-reputation job ${jobId}`);

    // Update guard row with real txHash + metadata
    try {
      await (prisma as any).agentLedgerEntry.update({
        where: { dedupeKey },
        data: { txHash: onChainTxHash.toLowerCase(), metadata: { phase: "complete", providerTokenId, tag, feedbackHash, escrowTxHash: txHash, onChainTxHash } },
      });
    } catch {}

    // Also update guard's txHash via raw if needed (already unique)
    return { attempted: true, txHash: onChainTxHash, deduped: false };
  } catch (e: any) {
    // On failure, delete guard so retry can attempt again (idempotency is still safe because on-chain feedback dedupes by feedbackHash, but we want to retry)
    // Instead keep guard but mark failed — future attempts will see guard and dedupe incorrectly. So delete.
    try { await (prisma as any).agentLedgerEntry.delete({ where: { dedupeKey } }).catch(() => {}); } catch {}
    console.error(`[autoReputation] giveFeedback failed for job ${jobId}:`, e?.message);
    return { attempted: false, reason: e?.message || String(e) };
  }
}
