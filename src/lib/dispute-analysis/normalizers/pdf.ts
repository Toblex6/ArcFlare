// src/lib/dispute-analysis/normalizers/pdf.ts
//
// Deterministic PDF text extraction (pdf-parse) — no AI provider call, no
// hallucinated extraction. This is intentional per the "optimize for text
// evidence, don't block on a vision provider" decision: most receipts,
// shipping confirmations, and transaction proofs submitted as PDFs are
// text-layer PDFs (invoices, exported receipts), not scans. Scanned/
// image-only PDFs will fail here with a clear message pointing at the
// vision extension point rather than silently returning garbage.

import type { EvidenceNormalizer } from './types';
import type { RawEvidence, NormalizedEvidence } from '../types';

async function extractPdfText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch PDF at ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Lazy import — pdf-parse pulls in extra deps we don't want loaded for
  // evidence types that never touch a PDF. The ESM build exports the
  // parser directly (no `.default`); the CJS build has `.default`.
  const pdfParseModule: any = await import('pdf-parse');
  const pdfParse = pdfParseModule.default ?? pdfParseModule;
  const parsed = await pdfParse(buffer);
  return parsed.text.trim();
}

export const pdfNormalizer: EvidenceNormalizer = {
  name: 'pdf',
  supports: (e: RawEvidence) => e.type === 'pdf' || e.mimeType === 'application/pdf',
  async normalize(e: RawEvidence): Promise<NormalizedEvidence> {
    const text = await extractPdfText(e.content);
    if (!text) {
      throw new Error(
        'PDF text extraction returned no content — likely a scanned/image-only PDF. ' +
        'This needs a vision-capable provider, not yet configured (see providers/registry.ts).'
      );
    }
    return {
      id: e.id,
      kind: e.type,
      submittedBy: e.submittedBy,
      role: e.role as any,
      extractedText: text,
      mediaUrl: e.content,
      timestamp: e.createdAt.toISOString(),
      normalizerUsed: 'pdf-deterministic',
    };
  },
};
