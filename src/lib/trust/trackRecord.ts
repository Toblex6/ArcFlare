// src/lib/trust/trackRecord.ts
// Verifiable track record — derived from authoritative sources, no double counting.
// One completed job = one completed job, even if it appears in ledger + PaymentLog + Job.

import { prisma } from "@/lib/prisma";
import { computeTrustScore, TRUST_METHODOLOGY_VERSION } from "./trustScore";
import { readOnChainReputation } from "./reputationReader";

export interface TrackRecord {
  agent: { id: number; tokenId: string; scaAddress: string; name: string; status: string };
  trust: Awaited<ReturnType<typeof computeTrustScore>>;
  reputation: Awaited<ReturnType<typeof readOnChainReputation>>;
  // DB fallback reputation (fast, deterministic)
  dbReputation: number;
  stats: {
    completedJobs: number;
    totalJobs: number;
    failedJobs: number;
    validatedJobs: number;
    validationPassRate: number | null;
    validatedVolume: string; // 6-dec bigint string
    validatedVolumeUSDC: string; // formatted
    reputationCount: number | null;
    uniqueValidators: number;
    lastActivityAt: string | null;
  };
  recentOutcomes: Array<{
    jobId: string;
    status: string;
    budget: string;
    validation: { status: string | null; validatorSCA: string | null; requestHash: string | null; passed: boolean | null } | null;
    txHash: string | null;
    updatedAt: string;
  }>;
  evidenceReferences: {
    jobIds: string[];
    validationRequestHashes: string[];
    txHashes: string[];
    reputationRegistry: string;
    methodologyVersion: string;
  };
}

function fmtUSDC(s: string): string {
  try { const n = Number(BigInt(s)) / 1e6; return n.toFixed(2); } catch { return "0.00"; }
}

export async function getTrackRecord(agentRegistryId: number): Promise<TrackRecord> {
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentRegistryId } });
  if (!agent) throw new Error(`agent ${agentRegistryId} not found`);

  const trust = await computeTrustScore(agentRegistryId);
  let rep: Awaited<ReturnType<typeof readOnChainReputation>>;
  try { rep = await readOnChainReputation(agent.tokenId); } catch (e: any) {
    rep = { tokenId: String(agent.tokenId), reputationScore: null, reputationCount: null, positiveCount: null, negativeCount: null, recentFeedback: [], registryAddress: process.env.REPUTATION_REGISTRY_ADDRESS || "0x8004B663056A597Dffe9eCcC1965A193B7388713", readOk: false, error: e?.message };
  }

  const jobs: any[] = await (prisma as any).erc8183Job.findMany({ where: { providerSCA: { equals: agent.scaAddress, mode: "insensitive" } }, orderBy: { updatedAt: "desc" }, take: 20 }).catch(() => []);
  const jobIds = jobs.map((j) => j.jobId);
  let validations: any[] = [];
  if (jobIds.length > 0) {
    validations = await (prisma as any).erc8183JobValidation.findMany({ where: { jobId: { in: jobIds } } }).catch(() => []);
  }
  const vByJob = new Map<string, any>(validations.map((v: any) => [String(v.jobId), v]));

  // Ledger revenue for validated volume (exclude self-hire)
  let ledger: any[] = [];
  try { ledger = await (prisma as any).agentLedgerEntry.findMany({ where: { agentRegistryId, type: "REVENUE", direction: "CREDIT" } }).catch(() => []); } catch {}
  const selfHireIds = new Set(jobs.filter((j) => String(j.clientSCA).toLowerCase() === String(agent.scaAddress).toLowerCase()).map((j) => String(j.jobId)));
  const eligible = ledger.filter((e) => !selfHireIds.has(String(e.jobId ?? "")));
  const validatedVolume = eligible.reduce((a: bigint, e: any) => a + BigInt(e.amount || "0"), 0n).toString();

  const recentOutcomes = jobs.slice(0, 10).map((j) => {
    const v = vByJob.get(String(j.jobId));
    return {
      jobId: String(j.jobId),
      status: String(j.status),
      budget: String(j.budget),
      validation: v ? { status: String(v.status), validatorSCA: v.validatorSCA ?? null, requestHash: v.requestHash ?? null, passed: v.status === "PASSED" ? true : v.status === "FAILED" ? false : null } : null,
      txHash: Array.isArray(j.txHashes) && j.txHashes.length > 0 ? String(j.txHashes[j.txHashes.length - 1]) : null,
      updatedAt: new Date(j.updatedAt || j.createdAt).toISOString(),
    };
  });

  const lastActivityAt = jobs.length > 0 ? new Date(jobs[0].updatedAt || jobs[0].createdAt).toISOString() : null;

  return {
    agent: { id: agent.id, tokenId: String(agent.tokenId), scaAddress: agent.scaAddress, name: agent.name, status: agent.status },
    trust,
    reputation: rep,
    dbReputation: typeof agent.reputation === "number" ? agent.reputation : 50,
    stats: {
      completedJobs: trust.signals.completedJobs,
      totalJobs: trust.signals.totalJobs,
      failedJobs: trust.signals.failedJobs,
      validatedJobs: trust.signals.validatedJobs,
      validationPassRate: trust.signals.validationPassRate,
      validatedVolume,
      validatedVolumeUSDC: fmtUSDC(validatedVolume),
      reputationCount: rep.reputationCount ?? trust.signals.reputationCount,
      uniqueValidators: trust.signals.uniqueValidators,
      lastActivityAt,
    },
    recentOutcomes,
    evidenceReferences: {
      jobIds: jobs.map((j) => String(j.jobId)),
      validationRequestHashes: validations.map((v) => String(v.requestHash || "")).filter(Boolean),
      txHashes: jobs.flatMap((j) => Array.isArray(j.txHashes) ? j.txHashes : []).filter(Boolean).map(String),
      reputationRegistry: rep.registryAddress,
      methodologyVersion: TRUST_METHODOLOGY_VERSION,
    },
  };
}
