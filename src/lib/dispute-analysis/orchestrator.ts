// src/lib/dispute-analysis/orchestrator.ts
//
// The single entry point for running an analysis. Pure orchestration —
// reads evidence, normalizes it, runs the three LLM stages, returns a
// structured result. Does NOT write to the DisputeAnalysis table itself;
// the API route owns persistence/versioning so this function stays easy to
// test and reuse (e.g. from a background job later, not just the route).

import { prisma } from '@/src/lib/prisma';
import { resolveNormalizer } from './normalizers';
import { getProvider } from './providers/registry';
import { extractFacts } from './stages/extract-facts';
import { synthesize } from './stages/synthesize';
import { recommend } from './stages/recommend';
import type { DisputeAnalysisResult, NormalizedEvidence, RawEvidence } from './types';

export async function analyzeDispute(
  reference: string
): Promise<{ result: DisputeAnalysisResult; providerId: string }> {
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) throw new Error(`Escrow ${reference} not found.`);

  const evidence: RawEvidence[] = await (prisma as any).disputeEvidence.findMany({
    where: { reference },
    orderBy: { createdAt: 'asc' },
  });

  // Promise.allSettled — one bad evidence item (unreachable URL, scanned
  // PDF, unsupported type) never takes down the whole analysis. It shows up
  // in evidenceCoverage.failed instead.
  const settled = await Promise.allSettled(
    evidence.map((e) => resolveNormalizer(e).normalize(e))
  );

  const usable: NormalizedEvidence[] = [];
  const failed: { id: string; reason: string }[] = [];

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      usable.push(r.value);
    } else {
      failed.push({ id: evidence[i].id, reason: r.reason?.message || 'Unknown normalization error' });
    }
  });

  const textProvider = getProvider('text');

  const facts = await extractFacts(usable, textProvider);

  const { timeline, conflicts } = await synthesize(
    facts,
    {
      amount: escrow.amount,
      currency: escrow.currency,
      condition: escrow.condition,
      disputeReason: escrow.disputeReason,
    },
    textProvider
  );

  const recommendation = await recommend(
    facts,
    conflicts,
    {
      amount: escrow.amount,
      currency: escrow.currency,
      condition: escrow.condition,
      disputeReason: escrow.disputeReason,
      depositorSCA: escrow.depositorSCA,
      beneficiarySCA: escrow.beneficiarySCA,
    },
    textProvider
  );

  const result: DisputeAnalysisResult = {
    executiveSummary: recommendation.summary,
    timeline,
    keyFacts: facts,
    conflicts,
    confidenceScore: recommendation.confidence,
    recommendation: recommendation.verdict,
    explanation: recommendation.explanation,
    evidenceCoverage: { total: evidence.length, analyzed: usable.length, failed },
  };

  return { result, providerId: textProvider.id };
}
