/**
 * x402JobPayment.ts
 *
 * Wraps job funding and release as x402-negotiated payments, using your
 * EXISTING withGateway() from src/lib/x402.ts. This file does not modify
 * withGateway() — it calls it, the same way your other x402-settled routes
 * already do, then forwards the settled funds into ArcFlareJobEscrow via
 * the relayer-submitted fundJobFor()/releaseToWorkerFor() functions.
 *
 * Flow for funding a job (agent posting work):
 *   1. Agent hits POST /api/jobs/fund
 *   2. Route returns 402 Payment Required (via withGateway) if unpaid
 *   3. Agent signs from its own x402 EOA wallet (per-merchant AES-256-GCM
 *      encrypted key — same wallet used for the x402 Marketplace)
 *   4. withGateway() settles the payment through the Circle Batch Facilitator
 *      / Gateway Wallet, funds land with the relayer (your backend's
 *      settlement-holding address)
 *   5. This file's fundJobViaX402() takes over: hashes criteria, calls
 *      fundJobFor() on ArcFlareJobEscrow, forwarding the just-settled amount
 *
 * Flow for releasing to a worker on approval — same pattern, but release
 * doesn't need a NEW x402 payment (the money is already escrowed); it just
 * needs the relayer to submit releaseToWorkerFor() after your review/
 * verifyCallerControlsAddress checks pass.
 */

import type { NextRequest } from "next/server";
import { withGateway } from "@/lib/x402"; // existing, untouched
import { verifyCallerControlsAddress } from "@/lib/auth/verifyCallerControlsAddress";
import { hashCriteria, type AcceptanceCriteria } from "@/lib/jobs/criteriaHash";
import { getJobEscrowContract, getRelayerSigner, JOB_ESCROW_ABI } from "@/lib/wallet/jobEscrowClient";
import { getBuyerWalletPrivateKey } from "@/lib/x402-wallet";
import { checkSpendAllowed, recordSpend } from "@/lib/agents/spendLimitEnforcer";
import { recoverFromSpendLimitRaceFailure } from "@/lib/jobs/settlementRecovery";
import { getTokenBySymbol } from "@/lib/tokens/supportedTokens";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import { Contract, keccak256, toUtf8Bytes, Wallet } from "ethers";
import { prisma } from "@/lib/prisma"; // adjust to your actual client path

const SPEND_LIMIT_CONTRACT_ADDRESS = process.env.SPEND_LIMIT_CONTRACT_ADDRESS ?? "";
const SPEND_LIMIT_ABI = [
  "function checkAndRecordSpend(address agent, uint256 amount) external",
];

function getSpendLimitContractForRecording(): Contract {
  if (!SPEND_LIMIT_CONTRACT_ADDRESS) {
    throw new Error("SPEND_LIMIT_CONTRACT_ADDRESS is not configured — deploy ArcFlareSpendLimit.sol first");
  }
  return new Contract(SPEND_LIMIT_CONTRACT_ADDRESS, SPEND_LIMIT_ABI, getRelayerSigner());
}

const ARC_USDC_ADDRESS = getTokenBySymbol("USDC").address;

export interface FundJobParams {
  req: NextRequest;
  agentEoaAddress: string; // claimed by the request; verified below, not trusted blindly
  budget: bigint; // in USDC base units
  criteria: AcceptanceCriteria;
  maxRevisions?: number; // defaults to 3 if not provided — see rationale below
}

export interface FundJobResult {
  jobId: string;
  txHash: string;
  gatewayRef: string;
}

/**
 * Funds a job via x402, then forwards the settled amount into escrow.
 * This is the function your `jobs/fund` route should call.
 */
export async function fundJobViaX402(params: FundJobParams): Promise<FundJobResult> {
  const { req, agentEoaAddress, budget, criteria } = params;
  // Default cap of 3 revision cycles — matches Patron's observed pattern
  // (reject, revise, reject again, then escalate). Configurable per job
  // since some job types may warrant a tighter or looser cap; 3 is a
  // starting default, not a hard product decision — revisit once you have
  // real usage data on how often jobs actually need more than 3 rounds.
  const maxRevisions = params.maxRevisions ?? 3;

  // Step 1 — verify the agent claiming to fund this job actually controls
  // the wallet it says it does. Never trust agentEoaAddress from the body
  // alone (this is the same fix applied everywhere else per the audit).
  const callerCheck = await verifyCallerControlsAddress(req, agentEoaAddress, { role: "agent" });
  if (!callerCheck.ok) {
    throw new Error(`caller verification failed: ${callerCheck.reason}`);
  }

  // Step 1.5 — spend limit pre-flight. This happens BEFORE settlement, so a
  // capped-out agent gets a clean rejection instead of paying and then
  // failing to fund the job. Checks task/counterparty caps (backend) then
  // the on-chain hard cap (view-only, doesn't record yet).
  const spendCheck = await checkSpendAllowed({
    agentAddress: callerCheck.resolvedAddress!,
    amount: budget,
    taskId: criteria.jobId,
  });
  if (!spendCheck.allowed) {
    throw new Error(`spend limit rejected (${spendCheck.rejectedBy}): ${spendCheck.reason}`);
  }

  // Step 2 — settle payment through the EXISTING x402 gateway path.
  // withGateway() handles the 402 challenge/response and Circle Batch
  // Facilitator settlement exactly as it does for x402 Marketplace
  // purchases today. We are not reimplementing settlement here.
  const settlement = await withGateway({
    payerAddress: callerCheck.resolvedAddress!,
    tokenAddress: ARC_USDC_ADDRESS,
    amount: budget,
    // memo ties the on-chain payment back to the off-chain job record,
    // useful for reconciliation in the same way merchant gateway refs are
    // tracked separately from tx hashes elsewhere in FlareHQ
    memo: `job-fund:${criteria.jobId}`,
  });

  if (!settlement.success) {
    throw new Error(`x402 settlement failed: ${settlement.error ?? "unknown"}`);
  }

  // Step 2.5 — record the spend for real, now that money has actually moved.
  // This is the ACTUAL enforcement write on-chain (checkAndRecordSpend, not
  // the read-only wouldExceedLimit used in the pre-flight above). If a
  // concurrent spend from the same agent pushed it over cap between
  // pre-flight and now, this REVERTS — and settlement has already happened,
  // so we're holding the agent's money with no job to show for it. That
  // case is handled explicitly below, not left to fail silently.
  const spendLimitContract = getSpendLimitContractForRecording();
  try {
    const spendTx = await spendLimitContract.checkAndRecordSpend(callerCheck.resolvedAddress, budget);
    await spendTx.wait();
  } catch (spendLimitError) {
    const { refundTxHash, recoveryId } = await recoverFromSpendLimitRaceFailure({
      agentAddress: callerCheck.resolvedAddress!,
      amount: budget,
      jobCriteriaId: criteria.jobId,
      gatewayRef: settlement.gatewayRef,
      settlementTxHash: settlement.txHash, // NOTE: field name assumed — check withGateway()'s actual return shape; adjust if it's named differently (e.g. settlement.transactionHash)
      failureReason: (spendLimitError as Error).message,
    });

    throw new Error(
      `job funding failed after settlement due to a spend-limit race — ` +
      `your payment of ${budget} has been automatically refunded (tx: ${refundTxHash}). ` +
      `Recovery record: ${recoveryId}. Please retry once your spending window allows it.`
    );
  }

  await recordSpend({
    agentAddress: callerCheck.resolvedAddress!,
    amount: budget,
    taskId: criteria.jobId,
  });

  // Step 3 — forward the now-settled funds into ArcFlareJobEscrow via the
  // relayer path, so the worker-facing one-way guarantee applies from here
  // forward regardless of how the poster paid in.
  const relayerSigner = getRelayerSigner();
  const escrow = getJobEscrowContract(relayerSigner);

  const criteriaHash = hashCriteria(criteria);
  const tx = await escrow.fundJobFor(
    callerCheck.resolvedAddress,
    ARC_USDC_ADDRESS,
    budget,
    criteriaHash,
    maxRevisions
  );
  const receipt = await tx.wait();

  // jobId is emitted in JobFunded — extract from logs rather than assuming
  // nextJobId ordering, since concurrent fundings could race.
  const jobId = extractJobIdFromReceipt(receipt);

  return {
    jobId: jobId.toString(),
    txHash: receipt.hash,
    gatewayRef: settlement.gatewayRef, // kept separate from txHash, same split pattern used for merchant settlement
  };
}

export interface ReleaseJobParams {
  req: NextRequest;
  posterAddress: string; // claimed; verified below
  jobId: string;
}

export interface ReleaseJobResult {
  txHash: string;
}

/**
 * Releases an already-escrowed job to its worker. No new x402 payment
 * needed here — funds are already in the contract. This just authorizes
 * and submits the release via the relayer.
 */
export async function releaseJobViaRelayer(params: ReleaseJobParams): Promise<ReleaseJobResult> {
  const { req, posterAddress, jobId } = params;

  const callerCheck = await verifyCallerControlsAddress(req, posterAddress, { role: "merchant" });
  // NOTE: role here assumes the poster is typically a merchant/business
  // account funding agent-hired work. If posters can also be raw agents
  // (agent-hires-human directly, no merchant account), add an `agent`
  // fallback check here — flagging rather than assuming, since your
  // handoff notes don't specify which role posts jobs.
  if (!callerCheck.ok) {
    throw new Error(`caller verification failed: ${callerCheck.reason}`);
  }

  const relayerSigner = getRelayerSigner();
  const escrow = getJobEscrowContract(relayerSigner);

  const tx = await escrow.releaseToWorkerFor(jobId);
  const receipt = await tx.wait();

  return { txHash: receipt.hash };
}

function extractJobIdFromReceipt(receipt: any): bigint {
  // Shared helper — JobFunded.jobId is indexed; parseEventValue handles
  // indexed and non-indexed fields uniformly.
  return parseEventValue(receipt, JOB_ESCROW_ABI, "JobFunded", "jobId");
}

// ---- Reject / revise ----

export interface RejectSubmissionParams {
  req: NextRequest;
  posterAddress: string; // claimed; verified below
  jobId: string;
  feedbackText: string; // full text — hashed for on-chain commit, stored in full off-chain
}

export interface RejectSubmissionResult {
  txHash: string;
  feedbackId: string; // off-chain record id, for retrieving the full feedback text later
}

/**
 * Rejects a submission with feedback. The feedback TEXT is stored off-chain
 * (your DB) — only its hash goes on-chain, via rejectSubmission() on the
 * contract, matching the same commit pattern as criteriaHash. This keeps
 * gas costs sane while still letting you prove later exactly what feedback
 * was given, since the hash on-chain can be checked against the stored text.
 *
 * Reverts on-chain if the job's maxRevisions cap has already been reached —
 * surface that error clearly to the poster/reviewer rather than a generic
 * failure, since "you've used all your revision rounds, release or dispute
 * instead" is actionable information.
 */
export async function rejectSubmissionWithFeedback(
  params: RejectSubmissionParams
): Promise<RejectSubmissionResult> {
  const { req, posterAddress, jobId, feedbackText } = params;

  const callerCheck = await verifyCallerControlsAddress(req, posterAddress, { role: "agent" });
  // role MUST match the funding path: fundJobViaX402 also verifies role
  // "agent" and passes callerCheck.resolvedAddress (the agent's own EOA)
  // as the `payer`/poster to fundJobFor(). That is what makes the funding
  // path PROVE which address the deployed contract has as job.poster —
  // this reject call must resolve the SAME identity.
  if (!callerCheck.ok) {
    throw new Error(`caller verification failed: ${callerCheck.reason}`);
  }

  // Store full feedback text off-chain first, so we have the hash-preimage
  // durably recorded before committing the hash on-chain.
  const feedbackRecord = await prisma.jobFeedback.create({
    data: { jobId, feedbackText, authorAddress: callerCheck.resolvedAddress! },
  });

  const feedbackHash = keccak256(toUtf8Bytes(feedbackText)) as `0x${string}`;

  // rejectSubmission() on the deployed ArcFlareJobEscrow requires
  // msg.sender == job.poster — it is NOT a relayer call (unlike
  // fundJobFor/releaseToWorkerFor). The funding path set poster = the
  // agent's EOA, so this MUST be signed by that exact EOA. We resolve the
  // agent's owning merchant's EXISTING x402 EOA key and refuse to sign
  // unless it provably matches the on-chain poster — never guessing.
  const posterKey = await resolveAgentPosterKey(callerCheck.callerId!, callerCheck.resolvedAddress!);
  const posterSigner = new Wallet(posterKey, getRelayerSigner().provider);
  const escrow = getJobEscrowContract(posterSigner);

  let receipt;
  try {
    const tx = await escrow.rejectSubmission(jobId, feedbackHash);
    receipt = await tx.wait();
  } catch (err) {
    // Surface the revision-cap case distinctly, since it's an expected,
    // actionable outcome — not a generic failure.
    const message = (err as Error).message ?? "";
    if (message.includes("revision cap reached")) {
      throw new Error(
        `revision cap reached for job ${jobId} — feedback was recorded (id: ${feedbackRecord.id}) ` +
        `but could not be committed on-chain because no revisions remain. ` +
        `Use releaseToWorker() to accept anyway, or raiseDispute() to escalate.`
      );
    }
    throw err;
  }

  await prisma.jobFeedback.update({
    where: { id: feedbackRecord.id },
    data: { onChainTxHash: receipt.hash, feedbackHash },
  });

  return { txHash: receipt.hash, feedbackId: feedbackRecord.id };
}

/**
 * Resolves the private key that must sign rejectSubmission: the key of the
 * agent's owning merchant's EXISTING x402 EOA wallet (the design's identity
 * for an agent's EOA — same wallet the funding path's agent uses to sign
 * x402 payments). Guards the invariant the deployed contract enforces:
 * signer.address MUST equal the on-chain job.poster. If the merchant has no
 * x402 wallet yet, or its address differs from the poster, we throw rather
 * than guess — a wrong signer would revert on-chain anyway.
 */
async function resolveAgentPosterKey(agentId: string, expectedPosterAddress: string): Promise<`0x${string}`> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      walletAddress: true,
      registry: { select: { merchantId: true } },
    },
  });
  const merchantId = agent?.registry?.merchantId;
  if (!merchantId) {
    throw new Error(`agent ${agentId} has no owning merchant — cannot resolve the poster signing key for rejectSubmission`);
  }

  const privateKey = await getBuyerWalletPrivateKey(merchantId);
  if (!privateKey) {
    throw new Error(
      `merchant ${merchantId} has no x402 EOA wallet — the poster signing key needed for ` +
      `rejectSubmission does not exist. The funding path must have used this wallet as the poster.`
    );
  }

  const signerAddress = new Wallet(privateKey).address;
  if (signerAddress.toLowerCase() !== expectedPosterAddress.toLowerCase()) {
    throw new Error(
      `poster signing key (${signerAddress}) does not match the on-chain job.poster (${expectedPosterAddress}) — ` +
      `refusing to sign rejectSubmission with a key that is not the poster. ` +
      `The funding path must have set the poster to the agent's own x402 EOA (agent ${agentId} wallet: ${agent.walletAddress}).`
    );
  }

  return privateKey;
}
