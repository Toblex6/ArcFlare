// src/lib/dispute-analysis/normalizers/index.ts
//
// Order matters: mimeType-specific normalizers (pdf, image) are checked
// before the generic link fallback, so a receipt/shipping_confirmation/
// transaction_proof with a known mimeType gets real extraction instead of
// a raw-fetch dump. Adding a new evidence type later means writing one file
// implementing EvidenceNormalizer and adding it to this list — nothing in
// the orchestrator or output schema changes.

import type { EvidenceNormalizer } from './types';
import type { RawEvidence } from '../types';
import { UnsupportedEvidenceError } from '../errors';
import { textNormalizer } from './text';
import { pdfNormalizer } from './pdf';
import { imageNormalizer } from './image';
import { linkNormalizer } from './link';

const registry: EvidenceNormalizer[] = [
  textNormalizer,
  pdfNormalizer,
  imageNormalizer,
  linkNormalizer,
];

export function resolveNormalizer(evidence: RawEvidence): EvidenceNormalizer {
  const match = registry.find((n) => n.supports(evidence));
  if (!match) throw new UnsupportedEvidenceError(evidence.type);
  return match;
}

export type { EvidenceNormalizer } from './types';
