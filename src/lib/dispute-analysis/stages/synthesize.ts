// src/lib/dispute-analysis/stages/synthesize.ts

import type { AIProvider } from '../providers/types';
import type { ExtractedFact, TimelineEvent, ConflictFlag } from '../types';

interface EscrowContext {
  amount: number;
  currency: string;
  condition: string | null;
  disputeReason: string | null;
}

export async function synthesize(
  facts: ExtractedFact[],
  escrowContext: EscrowContext,
  provider: AIProvider
): Promise<{ timeline: TimelineEvent[]; conflicts: ConflictFlag[] }> {
  if (facts.length === 0) {
    return { timeline: [], conflicts: [] };
  }

  const prompt = `Given these extracted facts from a payment dispute (escrow condition: "${escrowContext.condition || 'not specified'}", dispute reason: "${escrowContext.disputeReason || 'not specified'}", amount: ${escrowContext.amount} ${escrowContext.currency}):

${JSON.stringify(facts, null, 2)}

1. Build a chronological timeline of events. Use null for timestamp if only relative ordering is known.
2. Identify conflicts — facts that contradict each other or seem suspicious (e.g. mismatched dates, amounts, or claims). Rate severity low/medium/high.

Respond ONLY with valid JSON:
{"timeline": [{"timestamp": string|null, "description": string, "sourceEvidenceIds": string[]}], "conflicts": [{"description": string, "conflictingEvidenceIds": string[], "severity": "low"|"medium"|"high"}]}`;

  const raw = await provider.chatComplete(
    [
      { role: 'system', content: 'You synthesize dispute facts into a timeline and flag conflicts. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    { jsonMode: true }
  );

  try {
    const parsed = JSON.parse(raw);
    return {
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    };
  } catch (err: any) {
    throw new Error(`Synthesis returned unparseable JSON: ${err.message}`);
  }
}
