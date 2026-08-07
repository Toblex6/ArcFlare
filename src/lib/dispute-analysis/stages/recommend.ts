// src/lib/dispute-analysis/stages/recommend.ts

import type { AIProvider } from '../providers/types';
import type { ExtractedFact, ConflictFlag, DisputeRecommendation } from '../types';

interface EscrowContext {
  amount: number;
  currency: string;
  condition: string | null;
  disputeReason: string | null;
  depositorSCA: string;
  beneficiarySCA: string;
}

export interface RecommendationOutput {
  summary: string;
  confidence: number;
  verdict: DisputeRecommendation;
  explanation: string;
}

const VALID_VERDICTS: DisputeRecommendation[] = [
  'RELEASE_TO_BENEFICIARY',
  'REFUND_TO_DEPOSITOR',
  'INSUFFICIENT_EVIDENCE',
];

export async function recommend(
  facts: ExtractedFact[],
  conflicts: ConflictFlag[],
  escrowContext: EscrowContext,
  provider: AIProvider
): Promise<RecommendationOutput> {
  const prompt = `You are assisting a human admin reviewing a payment dispute on FlareHQ. You do NOT make the final decision — you provide a recommendation and confidence score the admin will weigh alongside their own judgment. The admin's resolve action is the only thing that actually moves funds.

Escrow: ${escrowContext.amount} ${escrowContext.currency}, condition: "${escrowContext.condition || 'not specified'}", dispute reason: "${escrowContext.disputeReason || 'not specified'}"
Depositor: ${escrowContext.depositorSCA}
Beneficiary: ${escrowContext.beneficiarySCA}

Extracted facts:
${JSON.stringify(facts, null, 2)}

Conflicts/suspicious evidence:
${JSON.stringify(conflicts, null, 2)}

Based on this, provide:
- executiveSummary: 2-3 sentence overview
- confidence: 0-100, how confident you are given evidence quality/quantity. Low evidence or heavy conflicts should produce low confidence — never overstate.
- verdict: one of "RELEASE_TO_BENEFICIARY", "REFUND_TO_DEPOSITOR", "INSUFFICIENT_EVIDENCE" — use INSUFFICIENT_EVIDENCE if the evidence doesn't clearly support either side.
- explanation: human-readable reasoning an admin can quickly review, referencing specific evidence/fact IDs where relevant. Be explicit about any conflicts that weakened confidence.

Respond ONLY with valid JSON:
{"executiveSummary": string, "confidence": number, "verdict": string, "explanation": string}`;

  const raw = await provider.chatComplete(
    [
      { role: 'system', content: 'You are a careful, conservative dispute-evidence reviewer. You never overstate confidence. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    { jsonMode: true }
  );

  try {
    const parsed = JSON.parse(raw);
    const verdict: DisputeRecommendation = VALID_VERDICTS.includes(parsed.verdict)
      ? parsed.verdict
      : 'INSUFFICIENT_EVIDENCE';

    return {
      summary: String(parsed.executiveSummary || ''),
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
      verdict,
      explanation: String(parsed.explanation || ''),
    };
  } catch (err: any) {
    throw new Error(`Recommendation stage returned unparseable JSON: ${err.message}`);
  }
}
