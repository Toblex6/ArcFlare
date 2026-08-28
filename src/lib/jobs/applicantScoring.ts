/**
 * applicantScoring.ts
 *
 * Turns job assignment from "poster manually picks whoever" into a real
 * marketplace mechanic: applicants apply, get scored against each other,
 * and the poster (or an auto-assign policy) picks from a ranked list.
 *
 * DELIBERATELY BACKEND-ONLY — no contract changes needed. ArcFlareJobEscrow's
 * assignWorker(jobId, worker) already takes an arbitrary worker address;
 * this file just decides WHICH address to pass in. Scoring/ranking doesn't
 * need on-chain trustlessness the way payment/escrow does — it's a
 * marketplace-quality feature, not a funds-safety one, so keeping it in
 * the backend keeps it cheap to iterate on.
 *
 * SCOPE NOTE: this does not touch assignWorker() itself or any deployed
 * contract. It sits entirely in front of the existing
 * escrow.assignWorker() call in your jobs/assign route.
 *
 * INTEGRATION NOTES (Batch 6 wired into the real repo):
 * - The batch guessed `prisma.jobListing` with a string `budget`. This
 *   repo's real jobs model is `Erc8183Job` (on-chain ERC-8183 AgenticCommerce
 *   mirror), keyed by BigInt on-chain `jobId`, with `budget` as BigInt and
 *   `createdAt` as DateTime. Scoring targets that.
 * - There is NO `agentReputation` Prisma model. The real DB reputation
 *   field is `AgentRegistry.reputation` (Int, 0-100, default 50), looked up
 *   by `AgentRegistry.scaAddress`. On-chain ERC-8004 scores are recorded via
 *   the agent/reputation route but not mirrored into Postgres, so
 *   `AgentRegistry.reputation` is the authoritative Postgres signal.
 */

import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import type { NextRequest } from "next/server";

export interface ApplicationInput {
  jobId: string; // on-chain ERC-8183 job id (matches Erc8183Job.jobId)
  applicantAddress: string;
  proposedAmount?: bigint; // optional — applicant may propose under budget
  pitch: string; // short free-text pitch/cover note
  portfolioLinks?: string[];
}

export interface ScoredApplicant {
  applicantAddress: string;
  score: number; // 0-100, higher is better
  scoreBreakdown: ScoreBreakdown;
  proposedAmount: bigint | null;
  pitch: string;
}

export interface ScoreBreakdown {
  reputationScore: number;   // 0-40 — weighted heaviest, this is the trust signal
  priceScore: number;        // 0-25 — reward proposing under budget, not a race to the bottom
  completenessScore: number; // 0-20 — pitch quality/length, portfolio links present
  recencyPenalty: number;    // 0 to -15 — applying very late relative to job posting is a soft negative signal
}

/**
 * Records an application. No scoring happens here — scoring is computed
 * on-demand when the poster requests the ranked list, so reputation data
 * (which can change between application and review) is always fresh.
 */
export async function submitApplication(input: ApplicationInput): Promise<{ applicationId: string }> {
  const jobId = parseJobId(input.jobId);
  const job = await prisma.erc8183Job.findUnique({ where: { jobId } });
  if (!job) throw new Error(`job ${input.jobId} not found`);

  // Prevent duplicate applications from the same address on the same job.
  const existing = await prisma.jobApplication.findFirst({
    where: { jobId, applicantAddress: input.applicantAddress },
  });
  if (existing) {
    throw new Error(`address ${input.applicantAddress} has already applied to job ${input.jobId}`);
  }

  const application = await prisma.jobApplication.create({
    data: {
      jobId,
      applicantAddress: input.applicantAddress,
      proposedAmount: input.proposedAmount?.toString() ?? null,
      pitch: input.pitch,
      portfolioLinks: input.portfolioLinks ?? [],
    },
  });

  return { applicationId: application.id };
}

/**
 * Returns applicants for a job, ranked highest-score-first. Call this from
 * your jobs/{id}/applicants route so the poster (or an AI reviewer acting
 * on the poster's behalf) sees a ranked list instead of a raw feed.
 */
export async function getRankedApplicants(jobId: string): Promise<ScoredApplicant[]> {
  const parsedJobId = parseJobId(jobId);
  const job = await prisma.erc8183Job.findUnique({ where: { jobId: parsedJobId } });
  if (!job) throw new Error(`job ${jobId} not found`);

  const applications = await prisma.jobApplication.findMany({
    where: { jobId: parsedJobId },
    orderBy: { createdAt: "asc" },
  });
  if (applications.length === 0) return [];

  const scored = await Promise.all(
    applications.map((app) => scoreApplication(app, job))
  );

  return scored.sort((a, b) => b.score - a.score);
}

async function scoreApplication(app: any, job: any): Promise<ScoredApplicant> {
  const reputationScore = await getReputationScore(app.applicantAddress);
  const priceScore = getPriceScore(app.proposedAmount, job.budget.toString());
  const completenessScore = getCompletenessScore(app.pitch, app.portfolioLinks);
  const recencyPenalty = getRecencyPenalty(app.createdAt, job.createdAt);

  const totalScore = Math.max(
    0,
    Math.min(100, reputationScore + priceScore + completenessScore + recencyPenalty)
  );

  return {
    applicantAddress: app.applicantAddress,
    score: totalScore,
    scoreBreakdown: { reputationScore, priceScore, completenessScore, recencyPenalty },
    proposedAmount: app.proposedAmount ? BigInt(app.proposedAmount) : null,
    pitch: app.pitch,
  };
}

/**
 * Derived trust source: computeTrustScore(agentId) when available (job/validation/ledger evidence),
 * fallback to AgentRegistry.reputation (0..100, default 50) if trust unavailable or agent has no registry row.
 * Broken dependency fixed: previously returned 20 (half of 40 max) for unscored — now uses trust where available.
 */
async function getReputationScore(applicantAddress: string): Promise<number> {
  try {
    const agent = await prisma.agentRegistry.findFirst({
      where: { scaAddress: { equals: applicantAddress, mode: "insensitive" } },
    });
    if (!agent) return 20; // neutral default for first-time worker (no registry row)
    // Prefer derived trust (validated evidence-aware) over raw DB reputation
    try {
      const { computeTrustScore } = await import("@/lib/trust/trustScore");
      const trust = await computeTrustScore(agent.id);
      // Trust score 0..100 -> 0..40 points (same scale as reputationScore slot)
      return Math.round((Math.max(0, Math.min(100, trust.score)) / 100) * 40);
    } catch {}
    const reputation = typeof agent.reputation === "number" ? agent.reputation : 50;
    const normalized = Math.max(0, Math.min(100, reputation)) / 100;
    return Math.round(normalized * 40);
  } catch {
    return 20; // never let a reputation/trust lookup break the whole ranked list
  }
}

function getPriceScore(proposedAmount: string | null, budget: string): number {
  if (!proposedAmount) return 12; // no proposal = neutral, half of 25 max
  const proposed = BigInt(proposedAmount);
  const max = BigInt(budget);
  if (max <= 0n) return 0; // guard: no usable budget
  if (proposed > max) return 0; // over budget, disqualifying on price dimension
  if (proposed === BigInt(0)) return 0; // free work is a red flag, not a bonus — treat as suspicious, not optimal

  // Reward being under budget, but with diminishing returns — this avoids
  // incentivizing a pure race-to-the-bottom where the cheapest bid always
  // wins regardless of quality signals elsewhere.
  const ratio = Number(proposed) / Number(max); // 1.0 = at budget, lower = cheaper
  const discount = 1 - ratio; // 0 to ~1
  return Math.round(Math.min(25, 12 + discount * 25));
}

function getCompletenessScore(pitch: string, portfolioLinks: string[]): number {
  let score = 0;
  if (pitch && pitch.trim().length >= 40) score += 12; // meaningful pitch, not a one-liner
  else if (pitch && pitch.trim().length > 0) score += 5;
  if (portfolioLinks && portfolioLinks.length > 0) score += 8;
  return Math.min(20, score);
}

function getRecencyPenalty(applicationCreatedAt: Date, jobCreatedAt: Date): number {
  const hoursSincePosting = (applicationCreatedAt.getTime() - jobCreatedAt.getTime()) / (1000 * 60 * 60);
  if (hoursSincePosting <= 24) return 0; // no penalty within first day
  if (hoursSincePosting <= 72) return -5;
  return -15; // applying more than 3 days after posting — soft signal the applicant pool may already be thin/late
}

/**
 * Convenience wrapper: poster picks the top-ranked applicant and assigns
 * in one call. Still requires the poster to explicitly confirm — this does
 * NOT auto-assign without a human/reviewer action, since silently picking
 * for the poster removes their actual control over who does their work.
 */
export interface AssignTopApplicantParams {
  req: NextRequest;
  posterAddress: string;
  jobId: string;
}

export async function getTopApplicantForAssignment(
  params: AssignTopApplicantParams
): Promise<ScoredApplicant | null> {
  const { req, posterAddress, jobId } = params;

  const callerCheck = await verifyCallerControlsAddress(req, posterAddress);
  if (!callerCheck) {
    throw new Error("caller does not control posterAddress");
  }

  const ranked = await getRankedApplicants(jobId);
  return ranked[0] ?? null;
}

function parseJobId(jobId: string): bigint {
  try {
    return BigInt(jobId);
  } catch {
    throw new Error(`invalid job id: ${jobId}`);
  }
}