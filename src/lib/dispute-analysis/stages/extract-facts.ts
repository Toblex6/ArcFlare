// src/lib/dispute-analysis/stages/extract-facts.ts

import type { AIProvider } from '../providers/types';
import type { NormalizedEvidence, ExtractedFact } from '../types';

function buildEvidenceBlock(items: NormalizedEvidence[]): string {
  return items
    .map(
      (e) =>
        `[Evidence ${e.id}] role=${e.role} kind=${e.kind} submittedBy=${e.submittedBy} at=${e.timestamp}\n${e.extractedText}`
    )
    .join('\n\n---\n\n');
}

export async function extractFacts(
  items: NormalizedEvidence[],
  provider: AIProvider
): Promise<ExtractedFact[]> {
  if (items.length === 0) return [];

  const prompt = `You are analyzing evidence submitted in a payment dispute between two parties (depositor and beneficiary) on FlareHQ, a USDC escrow platform.

Below is all normalized evidence. Extract discrete, verifiable facts. For each fact, list which evidence IDs support it and how many independent pieces of evidence corroborate it.

Respond ONLY with valid JSON matching this shape:
{"facts": [{"fact": string, "sourceEvidenceIds": string[], "supportedBy": number}]}

EVIDENCE:
${buildEvidenceBlock(items)}`;

  const raw = await provider.chatComplete(
    [
      { role: 'system', content: 'You extract structured facts from dispute evidence. Output valid JSON only, no prose.' },
      { role: 'user', content: prompt },
    ],
    { jsonMode: true }
  );

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.facts)) throw new Error('facts is not an array');
    return parsed.facts;
  } catch (err: any) {
    throw new Error(`Fact extraction returned unparseable JSON: ${err.message}`);
  }
}
