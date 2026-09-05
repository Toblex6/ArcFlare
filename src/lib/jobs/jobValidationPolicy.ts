// src/lib/jobs/jobValidationPolicy.ts
//
// Minimal persistence + on-chain check for validation-gated jobs.
// Stores ONLY the relationship: jobId <-> validatorSCA + requestHash + status.
// The authoritative state is ALWAYS on-chain (getValidationStatus), not the DB.
// This file is the groundwork for Build 3 trust score: when a validation-gated
// job completes with PASS, the DB row + on-chain validation + PaymentLog +
// Erc8183Job together form the full economic evidence.

import { prisma } from "@/lib/prisma";
import { createPublicClient, http } from "viem";

const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as `0x${string}`; // job validation uses the same registry as agent validation (validationRequest), not NEXT_PUBLIC_VALIDATION_REGISTRY (requestValidation)

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] }, public: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

// ABI matching the deployed ValidationRegistry (route's ABI, not contract file's requestValidation)
// The route uses validationRequest/validationResponse/getValidationStatus
const VALIDATION_ABI = [
  {
    name: "validationRequest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "requestURI", type: "string" },
      { name: "requestHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "validationResponse",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestHash", type: "bytes32" },
      { name: "response", type: "uint8" },
      { name: "responseURI", type: "string" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "getValidationStatus",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "requestHash", type: "bytes32" }],
    outputs: [
      { name: "validatorAddress", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "response", type: "uint8" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
      { name: "lastUpdate", type: "uint256" },
    ],
  },
] as const;

export interface JobValidationPolicy {
  id: string;
  jobId: bigint;
  validatorSCA: string;
  requestHash: string | null;
  requestTxHash: string | null;
  responseTxHash: string | null;
  status: string;
  tag: string | null;
  required: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get the validation policy for a job, if any.
 * Returns null for normal (non-validation) jobs.
 */
export async function getJobValidationPolicy(jobId: bigint): Promise<JobValidationPolicy | null> {
  const row = await (prisma as any).erc8183JobValidation.findUnique({ where: { jobId } });
  return row as JobValidationPolicy | null;
}

/**
 * Create a validation requirement for a job at hire time.
 * Idempotent: if a policy already exists for this job, return it.
 *
 * Central self-validation guard (defense-in-depth — callers may still
 * pre-check for a nicer 400, but this function is the authoritative invariant):
 * the validator MUST be a third party, distinct from BOTH the job's client
 * (clientSCA) and its provider (providerSCA). Comparison is normalized /
 * case-insensitive, matching the semantics already used by hire callers.
 * Enforcement reads the persisted Erc8183Job row, so callers must persist that
 * row (with clientSCA/providerSCA) BEFORE calling this. Throws an Error when
 * the invariant is violated or when the job row is absent (fail-closed: without
 * the row we cannot prove the validator is a third party). Policy-creation
 * failures are handled by callers and must not fail an already-created hire.
 */
export async function createJobValidationPolicy(
  jobId: bigint,
  validatorSCA: string,
  tag?: string
): Promise<JobValidationPolicy> {
  const existing = await getJobValidationPolicy(jobId);
  if (existing) return existing;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(validatorSCA)) {
    throw new Error("validatorSCA must be a valid 0x address");
  }

  const normalizedValidator = validatorSCA.toLowerCase();
  const job = await (prisma as any).erc8183Job.findUnique({
    where: { jobId },
    select: { clientSCA: true, providerSCA: true },
  });
  if (!job) {
    throw new Error("cannot create validation policy: job not found");
  }
  if (normalizedValidator === job.clientSCA.toLowerCase()) {
    throw new Error("validator cannot be the job client (self-validation)");
  }
  if (job.providerSCA && normalizedValidator === job.providerSCA.toLowerCase()) {
    throw new Error("validator cannot be the job provider (self-validation)");
  }

  const row = await (prisma as any).erc8183JobValidation.create({
    data: {
      jobId,
      validatorSCA: normalizedValidator,
      tag: tag || null,
      status: "PENDING",
      required: true,
    },
  });
  return row as JobValidationPolicy;
}

/**
 * Record a validation request (on-chain validationRequest tx landed).
 * Updates the policy with requestHash and requestTxHash, status -> REQUESTED.
 */
export async function recordValidationRequest(
  jobId: bigint,
  requestHash: string,
  requestTxHash: string
): Promise<JobValidationPolicy> {
  const row = await (prisma as any).erc8183JobValidation.update({
    where: { jobId },
    data: {
      requestHash: requestHash.toLowerCase(),
      requestTxHash,
      status: "REQUESTED",
      updatedAt: new Date(),
    },
  });
  return row as JobValidationPolicy;
}

/**
 * Record a validation response (on-chain validationResponse tx landed).
 * Updates status to PASSED (response 100) or FAILED (response 0).
 */
export async function recordValidationResponse(
  jobId: bigint,
  responseTxHash: string,
  passed: boolean,
  tag?: string
): Promise<JobValidationPolicy> {
  const status = passed ? "PASSED" : "FAILED";
  const row = await (prisma as any).erc8183JobValidation.update({
    where: { jobId },
    data: {
      responseTxHash,
      status,
      tag: tag || undefined,
      updatedAt: new Date(),
    },
  });
  return row as JobValidationPolicy;
}

/**
 * Locate a job-backed validation policy by its on-chain requestHash.
 * requestHash is stored lowercase and is unique; the lookup is therefore
 * case-insensitive. Returns null when the hash belongs to a plain ERC-8004
 * agent-validation request that is NOT job-backed.
 */
export async function getJobValidationPolicyByRequestHash(requestHash: string): Promise<JobValidationPolicy | null> {
  const row = await (prisma as any).erc8183JobValidation.findUnique({
    where: { requestHash: requestHash.toLowerCase() },
  });
  return (row as JobValidationPolicy) ?? null;
}

/**
 * Best-effort DB mirror of an authoritative on-chain validationResponse for a
 * job-backed request. If requestHash maps to an Erc8183JobValidation record,
 * applies the SAME status/result semantics as the job-scoped respond route
 * (recordValidationResponse): status -> PASSED (on-chain 100) / FAILED (on-chain 0),
 * plus responseTxHash and response tag. Returns { synced: false, status: null }
 * when the hash is not job-backed (no DB row to keep in sync).
 * Throws on real DB errors — callers MUST treat this as best-effort and never
 * fail an already-successful on-chain response because of a DB hiccup.
 */
export async function syncJobValidationResponseByRequestHash(
  requestHash: string,
  responseTxHash: string,
  passed: boolean,
  tag?: string
): Promise<{ synced: boolean; status: string | null }> {
  const policy = await getJobValidationPolicyByRequestHash(requestHash);
  if (!policy) return { synced: false, status: null };
  const updated = await recordValidationResponse(policy.jobId, responseTxHash, passed, tag);
  return { synced: true, status: updated.status };
}

/**
 * Read the authoritative on-chain validation status for a requestHash.
 * Returns { validatorAddress, agentId, response, passed, pending, tag, lastUpdate }.
 * Uses the existing ValidationRegistry's getValidationStatus, same as the
 * existing /api/agent/validation GET handler.
 */
export async function getOnChainValidationStatus(requestHash: string): Promise<{
  validatorAddress: string;
  agentId: bigint;
  response: number;
  passed: boolean;
  pending: boolean;
  tag: string;
  lastUpdate: bigint;
}> {
  const result = (await publicClient.readContract({
    address: VALIDATION_REGISTRY,
    abi: VALIDATION_ABI,
    functionName: "getValidationStatus",
    args: [requestHash as `0x${string}`],
  })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint];

  const [validatorAddress, agentId, response, _responseHash, tag, lastUpdate] = result;
  const passed = response === 100;
  // Pending detection: validator set but response not yet 100 and tag empty means request made but validator hasn't responded yet.
  // The contract sets validatorAddress immediately on validationRequest, but response stays 0/""/ until validationResponse.
  // Using validatorAddress==0 only catches never-requested; after request we need tag=="" to distinguish pending from explicit FAIL (0 with tag).
  const pending = validatorAddress === "0x0000000000000000000000000000000000000000" || (response === 0 && tag === "" && lastUpdate !== 0n);
  return { validatorAddress, agentId, response, passed, pending, tag, lastUpdate };
}

/**
 * Check if a job's validation requirement is satisfied (PASSED on-chain).
 * For normal jobs (no policy), returns true (not gated).
 * For gated jobs, returns true only if on-chain status is PASSED.
 * Returns { allowed, reason } for the release gate.
 */
export async function isValidationSatisfiedForJob(jobId: bigint): Promise<{ allowed: boolean; reason: string }> {
  const policy = await getJobValidationPolicy(jobId);
  if (!policy || !policy.required) {
    return { allowed: true, reason: "no validation required" };
  }
  if (!policy.requestHash) {
    return { allowed: false, reason: "validation required but no request has been made" };
  }
  // Check on-chain status (authoritative)
  try {
    const onChain = await getOnChainValidationStatus(policy.requestHash);
    if (onChain.pending) {
      return { allowed: false, reason: "validation pending — validator has not responded" };
    }
    if (!onChain.passed) {
      return { allowed: false, reason: `validation failed (response ${onChain.response}, tag ${onChain.tag}) — release blocked` };
    }
    // Also verify the validator matches the policy's designated validator
    if (onChain.validatorAddress.toLowerCase() !== policy.validatorSCA.toLowerCase()) {
      return { allowed: false, reason: "on-chain validator does not match job's designated validator" };
    }
    return { allowed: true, reason: "validation PASSED" };
  } catch (e: any) {
    return { allowed: false, reason: `on-chain validation check failed: ${e.message}` };
  }
}

/**
 * Get full job validation status for API responses: DB policy + on-chain mirror.
 * Used by GET /api/jobs/[jobId]/validation
 */
export async function getJobValidationStatus(jobId: bigint): Promise<{
  policy: JobValidationPolicy | null;
  onChain: Awaited<ReturnType<typeof getOnChainValidationStatus>> | null;
  evidence: {
    jobId: string;
    validatorSCA: string | null;
    requestHash: string | null;
    onChainStatus: string | null;
    passed: boolean | null;
    pending: boolean | null;
  } | null;
}> {
  const policy = await getJobValidationPolicy(jobId);
  if (!policy) {
    return { policy: null, onChain: null, evidence: null };
  }
  let onChain: Awaited<ReturnType<typeof getOnChainValidationStatus>> | null = null;
  let evidence: any = null;
  if (policy.requestHash) {
    try {
      onChain = await getOnChainValidationStatus(policy.requestHash);
      evidence = {
        jobId: jobId.toString(),
        validatorSCA: policy.validatorSCA,
        requestHash: policy.requestHash,
        onChainStatus: onChain.pending ? "PENDING" : onChain.passed ? "PASSED" : "FAILED",
        passed: onChain.passed,
        pending: onChain.pending,
      };
    } catch (e) {
      evidence = {
        jobId: jobId.toString(),
        validatorSCA: policy.validatorSCA,
        requestHash: policy.requestHash,
        onChainStatus: "UNKNOWN",
        passed: null,
        pending: null,
      };
    }
  } else {
    evidence = {
      jobId: jobId.toString(),
      validatorSCA: policy.validatorSCA,
      requestHash: null,
      onChainStatus: "PENDING",
      passed: null,
      pending: true,
    };
  }
  return { policy, onChain, evidence };
}
