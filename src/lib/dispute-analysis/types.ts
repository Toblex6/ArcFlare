// src/lib/dispute-analysis/types.ts
//
// Core data contracts for the AI evidence analysis engine. This engine does
// NOT manage disputes, store evidence, or make binding decisions — it reads
// existing DisputeEvidence rows and produces a structured recommendation
// that the existing admin dispute dashboard displays. The existing
// resolve-dispute endpoints remain the only path that actually moves funds.

export type EvidenceRole = 'depositor' | 'beneficiary';

// Shape of a DisputeEvidence row as read from Prisma. Kept as a plain
// interface here (not imported from @prisma/client) so this module has no
// hard dependency on the generated client — makes it easier to unit test
// normalizers with fixtures.
export interface RawEvidence {
  id: string;
  reference: string;
  submittedBy: string;
  role: string;
  type: string;
  content: string;
  mimeType: string | null;
  createdAt: Date;
}

export interface NormalizedEvidence {
  id: string;
  kind: string; // original DisputeEvidence.type
  submittedBy: string;
  role: EvidenceRole;
  extractedText: string;
  mediaUrl?: string;
  timestamp: string; // ISO string, from DisputeEvidence.createdAt
  normalizerUsed: string;
}

export interface TimelineEvent {
  timestamp: string | null; // null when only relative ordering is known
  description: string;
  sourceEvidenceIds: string[];
}

export interface ExtractedFact {
  fact: string;
  sourceEvidenceIds: string[];
  supportedBy: number; // how many independent evidence items corroborate it
}

export interface ConflictFlag {
  description: string;
  conflictingEvidenceIds: string[];
  severity: 'low' | 'medium' | 'high';
}

export type DisputeRecommendation =
  | 'RELEASE_TO_BENEFICIARY'
  | 'REFUND_TO_DEPOSITOR'
  | 'INSUFFICIENT_EVIDENCE';

export interface DisputeAnalysisResult {
  executiveSummary: string;
  timeline: TimelineEvent[];
  keyFacts: ExtractedFact[];
  conflicts: ConflictFlag[];
  confidenceScore: number; // 0-100
  recommendation: DisputeRecommendation;
  explanation: string; // human-readable rationale, references evidence/fact IDs
  evidenceCoverage: {
    total: number;
    analyzed: number;
    failed: { id: string; reason: string }[];
  };
}
