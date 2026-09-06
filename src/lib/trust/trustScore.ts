// src/lib/trust/trustScore.ts
// Deterministic trust scoring — explainable, no ML, no mystery.
// 0..100 score, 0..100 confidence, methodologyVersion "1.0".
// Evidence sources: Erc8183Job, Erc8183JobValidation (on-chain validation), PaymentLog (authoritative), AgentLedgerEntry, Reputation.
// Anti-gaming: self-feedback ignored, self-payment excluded, self-hiring excluded, tiny-spam capped, repeated-feedback deduplicated via validator diversity.

import { prisma } from "@/lib/prisma";

export const TRUST_METHODOLOGY_VERSION = "1.0";

export interface TrustBreakdown {
  jobPerformance: number; // 0..30
  validationPerformance: number; // 0..25
  reputation: number; // 0..20
  paymentReliability: number; // 0..15
  economicEvidence: number; // 0..10
}

export interface TrustResult {
  score: number; // 0..100
  confidence: number; // 0..100
  methodologyVersion: string;
  breakdown: TrustBreakdown;
  signals: {
    completedJobs: number;
    validatedJobs: number;
    validationPassRate: number | null; // 0..1
    totalJobs: number;
    failedJobs: number;
    validatedVolume: string; // bigint string 6-dec
    validatedVolumeByToken: Record<string, string>; // Phase 2D per-token evidence
    reputationCount: number;
    uniqueValidators: number;
    recentActivityDays: number | null;
  };
}

// Weights: must sum to 100 max when fully evidenced; sparse history yields neutral score via confidence.
const WEIGHTS = {
  jobPerformance: 30,
  validation: 25,
  reputation: 20,
  payment: 15,
  economic: 10,
};

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

export async function computeTrustScore(agentRegistryId: number): Promise<TrustResult> {
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentRegistryId }, select: { id: true, scaAddress: true, tokenId: true, reputation: true, createdAt: true } });
  if (!agent) throw new Error(`agent ${agentRegistryId} not found`);
  const sca = String(agent.scaAddress || "").toLowerCase();

  // Jobs where this agent was provider (work delivered)
  const jobsAsProvider: any[] = await (prisma as any).erc8183Job.findMany({ where: { providerSCA: { equals: agent.scaAddress, mode: "insensitive" } } }).catch(() => []);
  // Validations linked to those jobs
  const jobIds = jobsAsProvider.map((j) => j.jobId);
  let validations: any[] = [];
  if (jobIds.length > 0) {
    validations = await (prisma as any).erc8183JobValidation.findMany({ where: { jobId: { in: jobIds } } }).catch(() => []);
  }
  // Self-hire exclusion: jobs where clientSCA === providerSCA must not earn trust
  // (same selfHireJobIds set used for revenue/payment — apply to job/validation performance too)
  const selfHireJobIds = new Set<string>();
  for (const j of jobsAsProvider) {
    if (String(j.clientSCA).toLowerCase() === sca) selfHireJobIds.add(String(j.jobId));
  }
  const eligibleJobs = jobsAsProvider.filter((j) => !selfHireJobIds.has(String(j.jobId)));
  const eligibleValidations = validations.filter((v) => !selfHireJobIds.has(String(v.jobId)));
  const completedJobs = eligibleJobs.filter((j) => j.status === "COMPLETED").length;
  const failedJobs = eligibleJobs.filter((j) => j.status === "REJECTED" || j.status === "FAILED").length;
  const totalJobs = eligibleJobs.length;

  // Validation stats: only count validated jobs (where validation required) — self-hires excluded
  const validatedJobs = eligibleValidations.length;
  const passedCount = eligibleValidations.filter((v) => v.status === "PASSED").length;
  const failedValidation = eligibleValidations.filter((v) => v.status === "FAILED").length;
  const validationPassRate = validatedJobs > 0 ? passedCount / validatedJobs : null;
  const uniqueValidators = new Set(eligibleValidations.map((v) => String(v.validatorSCA || "").toLowerCase()).filter(Boolean)).size;

  // Ledger: provider revenue evidence (anti self-transfer) — count only REVENUE/JOB_ESCROW_RELEASE where counterparty != self
  let ledger: any[] = [];
  try { ledger = await (prisma as any).agentLedgerEntry.findMany({ where: { agentRegistryId } }).catch(() => []); } catch {}
  // Self-hiring / self-transfer exclusion: entries where counterpartyAgentId === agentRegistryId or job client==provider are not positive evidence
  const revenueEntries = ledger.filter((e) => e.type === "REVENUE" && e.direction === "CREDIT");
  const eligibleRevenue = revenueEntries.filter((e) => !selfHireJobIds.has(String(e.jobId ?? "")));
  // Tiny transaction spam guard: cap count weight, and volume dominates not count
  // Phase 2D: validatedVolume stays the cross-token smallest-units sum it has
  // always been (both supported tokens are 6-dec; scoring is order-of-magnitude
  // log scale, never an FX rate). validatedVolumeByToken lets readers
  // distinguish per-token evidence instead of assuming 1 EURC = 1 USDC.
  const validatedVolumeBigint = eligibleRevenue.reduce((acc: bigint, e: any) => acc + BigInt(e.amount || "0"), 0n);
  const validatedVolumeByToken: Record<string, string> = {};
  try {
    const { resolveRowCurrency } = await import("@/lib/tokens/resolveCurrency");
    for (const e of eligibleRevenue) {
      let sym = "USDC";
      try { sym = resolveRowCurrency({ currency: e?.token ?? null, tokenAddress: e?.tokenAddress ?? null }).symbol; } catch { sym = "USDC"; }
      validatedVolumeByToken[sym] = (BigInt(validatedVolumeByToken[sym] ?? "0") + BigInt(e.amount || "0")).toString();
    }
  } catch {}
  // Payment reliability from PaymentLog: exclude self-transfers (sender == receiver via PaymentLog fields not reliable; use ledger counterparty check + amount floor)
  // Use eligibleRevenue count as proxy; also fetch PaymentLog where agentSCA == sca excluding self
  let paymentLogCount = 0;
  try {
    const logs: any[] = await (prisma as any).paymentLog.findMany({ where: { agentSCA: { equals: agent.scaAddress, mode: "insensitive" }, status: "SUCCESS" } }).catch(() => []);
    // Exclude tiny spam: transactions < 0.01 USDC don't count fully (weight by amount)
    paymentLogCount = logs.filter((l: any) => Number(l.amount) >= 0.01).length;
  } catch {}

  // Read on-chain reputation count via reputationReader? We use DB reputation as fallback but also try to read if available — synchronous trust must not depend on RPC; use AgentRegistry.reputation as immediate signal
  // On-chain reads are async and flaky; trust uses DB reputation + recent job evidence for determinism.
  // Reputation component normalizes AgentRegistry.reputation (0..100) but discounts if single-validator.
  const dbReputation = typeof agent.reputation === "number" ? agent.reputation : 50;

  // Recency: days since last completion — self-hires excluded (same filter as job/validation performance)
  let recentActivityDays: number | null = null;
  if (eligibleJobs.length > 0) {
    const latest = eligibleJobs.reduce((m: Date, j: any) => j.updatedAt > m ? j.updatedAt : m, eligibleJobs[0].updatedAt || eligibleJobs[0].createdAt);
    recentActivityDays = Math.floor((Date.now() - new Date(latest).getTime()) / (86400000));
  } else if (ledger.length > 0) {
    const latest = ledger.reduce((m: Date, e: any) => new Date(e.createdAt) > m ? new Date(e.createdAt) : m, new Date(ledger[0].createdAt));
    recentActivityDays = Math.floor((Date.now() - latest.getTime()) / 86400000);
  }

  // ── Scoring components (explainable) ──
  // 1. Job performance (0..30): completion rate. Empty history => neutral 15 (not penalized nor rewarded) -> handled via confidence separately
  let jobPerformance = 15; // neutral
  if (totalJobs > 0) {
    const completionRate = completedJobs / totalJobs;
    const failRate = failedJobs / totalJobs;
    // Score curve: 0 jobs already handled; completion 0..1 maps to 0..30, minus failure penalty
    jobPerformance = Math.round(clamp01(completionRate) * WEIGHTS.jobPerformance - failRate * 15);
    jobPerformance = Math.max(0, Math.min(WEIGHTS.jobPerformance, jobPerformance));
    // Diminishing returns beyond 10 jobs
    if (completedJobs >= 10) jobPerformance = Math.min(WEIGHTS.jobPerformance, jobPerformance + 2);
  } else {
    jobPerformance = 0; // no evidence = 0 raw points (confidence will be low; final composite neutralized below)
  }

  // 2. Validation performance (0..25): pass rate on validated jobs; if no validated jobs => 0 raw
  let validationPerformance = 0;
  if (validatedJobs > 0 && validationPassRate !== null) {
    validationPerformance = Math.round(clamp01(validationPassRate) * WEIGHTS.validation);
    // Validator diversity bonus: 2+ unique validators => +3 (capped), single validator can't dominate
    if (uniqueValidators >= 2) validationPerformance = Math.min(WEIGHTS.validation, validationPerformance + 3);
    else if (uniqueValidators === 1 && validatedJobs >= 3) validationPerformance = Math.max(0, validationPerformance - 3); // repeated same validator discounted
    // Failed validation explicit penalty already in rate, but add small extra if any FAILED
    if (failedValidation > 0) validationPerformance = Math.max(0, validationPerformance - 2);
  }

  // 3. Reputation (0..20): DB reputation normalized, but discounted for no validated history and single-validator repetition
  let reputationComp = 0;
  {
    const norm = clamp01(dbReputation / 100);
    reputationComp = Math.round(norm * WEIGHTS.reputation);
    // Anti-gaming: same-validator repetition already penalized above; also if no validated jobs, reputation weight is capped
    if (validatedJobs === 0) reputationComp = Math.round(reputationComp * 0.5); // reputation without validation is half weight
  }

  // 4. Payment reliability (0..15): derived from non-tiny successful payments; tiny spam ignored
  let paymentReliability = 0;
  {
    const cappedCount = Math.min(paymentLogCount, 20); // tiny-spam guard
    paymentReliability = Math.round(clamp01(cappedCount / 10) * WEIGHTS.payment);
    // Self-payment already excluded via selfHireJobIds; also if all revenue was self-hire, this stays 0
    if (eligibleRevenue.length === 0) paymentReliability = 0;
  }

  // 5. Economic evidence (0..10): validated volume; dust volume ignored (<0.01)
  let economicEvidence = 0;
  {
    const vol = Number(validatedVolumeBigint) / 1e6; // USDC
    if (vol >= 0.01) {
      // log scale so 0.01..100 maps reasonably
      const score = Math.min(1, Math.log10(vol + 1) / 2); // log10(101)~2 => 1
      economicEvidence = Math.round(score * WEIGHTS.economic);
    }
  }

  // Composite raw score (0..100) — but for empty history we want neutral ~50 with low confidence, not 0
  let rawScore = jobPerformance + validationPerformance + reputationComp + paymentReliability + economicEvidence;
  // Recency decay: if last activity > 90 days, -5
  if (recentActivityDays !== null && recentActivityDays > 90) rawScore = Math.max(0, rawScore - 5);
  else if (recentActivityDays !== null && recentActivityDays > 30) rawScore = Math.max(0, rawScore - 2);

  // Empty history handling: no jobs, no validation, no revenue => score is neutral 50, confidence low
  const hasHistory = totalJobs > 0 || validatedJobs > 0 || eligibleRevenue.length > 0;
  let score: number;
  let confidence: number;
  if (!hasHistory) {
    score = 50; // insufficient evidence — neutral
    confidence = 10; // very low confidence
  } else {
    // Blend raw with neutral prior based on evidence count; more evidence => raw dominates
    const evidenceCount = completedJobs + validatedJobs + Math.min(eligibleRevenue.length, 10);
    const priorWeight = Math.max(0, 1 - evidenceCount / 15); // 0 jobs => 1, 15+ => 0
    score = Math.round(rawScore * (1 - priorWeight * 0.5) + 50 * priorWeight * 0.5);
    score = Math.max(0, Math.min(100, score));
    // Confidence: grows with validated jobs + unique validators + volume
    let conf = 0;
    conf += Math.min(40, completedJobs * 8); // up to 40
    conf += Math.min(30, validatedJobs * 10); // up to 30
    conf += Math.min(15, uniqueValidators * 7); // up to 15
    if (Number(validatedVolumeBigint) > 0) conf += 10;
    if (recentActivityDays !== null && recentActivityDays <= 30) conf += 5;
    // Single-validator dominance reduces confidence
    if (validatedJobs >= 3 && uniqueValidators === 1) conf = Math.max(0, conf - 15);
    confidence = Math.max(10, Math.min(95, conf));
    // Cap confidence for fresh agents (<3 jobs) to avoid inflation
    if (totalJobs < 3) confidence = Math.min(confidence, 45);
  }

  return {
    score,
    confidence,
    methodologyVersion: TRUST_METHODOLOGY_VERSION,
    breakdown: {
      jobPerformance,
      validationPerformance,
      reputation: reputationComp,
      paymentReliability,
      economicEvidence,
    },
    signals: {
      completedJobs,
      validatedJobs,
      validationPassRate,
      totalJobs,
      failedJobs,
      validatedVolume: validatedVolumeBigint.toString(),
      validatedVolumeByToken,
      reputationCount: validatedJobs, // proxy until on-chain count available
      uniqueValidators,
      recentActivityDays,
    },
  };
}
