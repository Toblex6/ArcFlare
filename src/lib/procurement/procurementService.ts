// src/lib/procurement/procurementService.ts
// Core procurement logic: ranking, selection, hire.
// Reuses existing applicantScoring scoring (trust-aware), treasuryPolicy, spendLimit, hire flow.

import { prisma } from "@/lib/prisma";

export interface ScoredProcurementApplicant {
  applicantAddress: string;
  applicantAgentId: number | null;
  score: number;
  scoreBreakdown: { reputationScore: number; priceScore: number; completenessScore: number; recencyPenalty: number };
  proposedAmount: bigint | null;
  pitch: string;
  trust?: { score: number; confidence: number };
}

function toUnitsDecimal(v: any): string {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  if (/^\d+(\.\d{1,6})?$/.test(s)) return (BigInt(Math.round(parseFloat(s) * 1_000_000))).toString();
  throw new Error(`invalid amount ${v}`);
}

async function getReputationScore(applicantAddress: string): Promise<number> {
  try {
    const agent = await (prisma as any).agentRegistry.findFirst({
      where: { scaAddress: { equals: applicantAddress, mode: "insensitive" } },
    });
    if (!agent) return 20;
    try {
      const { computeTrustScore } = await import("@/lib/trust/trustScore");
      const trust = await computeTrustScore(agent.id);
      return Math.round((Math.max(0, Math.min(100, trust.score)) / 100) * 40);
    } catch {}
    const reputation = typeof agent.reputation === "number" ? agent.reputation : 50;
    return Math.round((Math.max(0, Math.min(100, reputation)) / 100) * 40);
  } catch { return 20; }
}

function getPriceScore(proposedAmount: string | null, budgetMax: string): number {
  if (!proposedAmount) return 12;
  const proposed = BigInt(proposedAmount);
  const max = BigInt(budgetMax);
  if (max <= 0n) return 0;
  if (proposed > max) return 0;
  if (proposed === 0n) return 0;
  const ratio = Number(proposed) / Number(max);
  const discount = 1 - ratio;
  return Math.round(Math.min(25, 12 + discount * 25));
}

function getCompletenessScore(pitch: string, portfolioLinks: string[]): number {
  let score = 0;
  if (pitch && pitch.trim().length >= 40) score += 12;
  else if (pitch && pitch.trim().length > 0) score += 5;
  if (portfolioLinks && portfolioLinks.length > 0) score += 8;
  return Math.min(20, score);
}

function getRecencyPenalty(appCreatedAt: Date, postingCreatedAt: Date): number {
  const hours = (appCreatedAt.getTime() - postingCreatedAt.getTime()) / (1000 * 60 * 60);
  if (hours <= 24) return 0;
  if (hours <= 72) return -5;
  return -15;
}

export async function getRankedProcurementApplicants(procurementId: string): Promise<ScoredProcurementApplicant[]> {
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id: procurementId } });
  if (!posting) throw new Error(`procurement ${procurementId} not found`);
  const apps = await (prisma as any).procurementApplication.findMany({
    where: { procurementId },
    orderBy: { createdAt: "asc" },
  });
  if (apps.length === 0) return [];
  const scored = await Promise.all(apps.map(async (app: any) => {
    const reputationScore = await getReputationScore(app.applicantAddress);
    const priceScore = getPriceScore(app.proposedAmount, posting.budgetMax);
    const completenessScore = getCompletenessScore(app.pitch, app.portfolioLinks);
    const recencyPenalty = getRecencyPenalty(app.createdAt, posting.createdAt);
    const total = Math.max(0, Math.min(100, reputationScore + priceScore + completenessScore + recencyPenalty));
    let trust: any = null;
    try {
      const agent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: app.applicantAddress, mode: "insensitive" } }, select: { id: true } });
      if (agent) {
        const { computeTrustScore } = await import("@/lib/trust/trustScore");
        const t = await computeTrustScore(agent.id);
        trust = { score: t.score, confidence: t.confidence };
      }
    } catch {}
    return {
      applicantAddress: app.applicantAddress,
      applicantAgentId: app.applicantAgentId ?? null,
      score: total,
      scoreBreakdown: { reputationScore, priceScore, completenessScore, recencyPenalty },
      proposedAmount: app.proposedAmount ? BigInt(app.proposedAmount) : null,
      pitch: app.pitch,
      trust,
    };
  }));
  return scored.sort((a, b) => b.score - a.score);
}

export async function evaluateProviderAcceptance(params: {
  providerAgentId: number;
  jobBudget: bigint;
  clientSCA: string;
  skill?: string | null;
  category?: string | null;
}): Promise<{ allowed: boolean; reason: string }> {
  const policy: any = await (prisma as any).agentProviderPolicy.findUnique({ where: { agentRegistryId: params.providerAgentId } }).catch(() => null);
  if (!policy) return { allowed: true, reason: "no policy — default accept" };
  if (!policy.autoAccept) return { allowed: false, reason: "provider autoAccept is false — manual acceptance required" };
  const minBudget = BigInt(policy.minBudget ?? "0");
  if (params.jobBudget < minBudget) return { allowed: false, reason: `budget ${params.jobBudget} < provider minBudget ${minBudget}` };
  // max concurrent
  try {
    const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: params.providerAgentId }, select: { scaAddress: true } });
    if (agent?.scaAddress) {
      const activeCount = await (prisma as any).erc8183Job.count({
        where: { providerSCA: { equals: agent.scaAddress, mode: "insensitive" }, status: { in: ["OPEN", "FUNDED", "SUBMITTED"] } },
      }).catch(() => 0);
      if (activeCount >= policy.maxConcurrentJobs) return { allowed: false, reason: `provider at maxConcurrentJobs ${policy.maxConcurrentJobs} (active ${activeCount})` };
    }
  } catch {}
  if (policy.minClientTrustScore !== null && policy.minClientTrustScore !== undefined) {
    // resolve client agent id by SCA
    try {
      const clientAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: params.clientSCA, mode: "insensitive" } }, select: { id: true } });
      if (clientAgent) {
        const { computeTrustScore } = await import("@/lib/trust/trustScore");
        const t = await computeTrustScore(clientAgent.id);
        if (t.score < policy.minClientTrustScore) return { allowed: false, reason: `client trust ${t.score} < provider minClientTrustScore ${policy.minClientTrustScore}` };
      } else {
        // no client trust history — treat as 50 neutral; if policy requires >50, reject
        if (50 < policy.minClientTrustScore) return { allowed: false, reason: `client has no trust history (neutral 50) < required ${policy.minClientTrustScore}` };
      }
    } catch (e: any) { return { allowed: false, reason: `trust check failed: ${e.message}` }; }
  }
  if (policy.allowedSkills && Array.isArray(policy.allowedSkills) && policy.allowedSkills.length > 0) {
    if (params.skill && !policy.allowedSkills.map((s: string) => String(s).toLowerCase()).includes(String(params.skill).toLowerCase())) {
      return { allowed: false, reason: `skill ${params.skill} not in provider allowedSkills` };
    }
  }
  if (policy.allowedCategories && Array.isArray(policy.allowedCategories) && policy.allowedCategories.length > 0) {
    if (params.category && !policy.allowedCategories.map((s: string) => String(s).toLowerCase()).includes(String(params.category).toLowerCase())) {
      return { allowed: false, reason: `category ${params.category} not in provider allowedCategories` };
    }
  }
  return { allowed: true, reason: "provider policy allows" };
}
