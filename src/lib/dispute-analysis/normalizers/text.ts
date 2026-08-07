// src/lib/dispute-analysis/normalizers/text.ts

import type { EvidenceNormalizer } from './types';
import type { RawEvidence, NormalizedEvidence } from '../types';

export const textNormalizer: EvidenceNormalizer = {
  name: 'text',
  supports: (e: RawEvidence) => e.type === 'text' || e.type === 'chat_export',
  async normalize(e: RawEvidence): Promise<NormalizedEvidence> {
    return {
      id: e.id,
      kind: e.type,
      submittedBy: e.submittedBy,
      role: e.role as any,
      extractedText: e.content,
      timestamp: e.createdAt.toISOString(),
      normalizerUsed: 'text',
    };
  },
};
