// src/lib/dispute-analysis/normalizers/types.ts

import type { RawEvidence, NormalizedEvidence } from '../types';

export interface EvidenceNormalizer {
  name: string;
  supports(evidence: RawEvidence): boolean;
  normalize(evidence: RawEvidence): Promise<NormalizedEvidence>;
}
