// src/lib/dispute-analysis/normalizers/link.ts
//
// Handles evidence submitted as a bare URL where we don't already know it's
// a PDF or image (those get routed to pdfNormalizer/imageNormalizer instead
// — see resolveNormalizer's ordering in index.ts). Covers "link" evidence
// plus receipt/shipping_confirmation/transaction_proof rows that are just
// links to a hosted page rather than a file.

import type { EvidenceNormalizer } from './types';
import type { RawEvidence, NormalizedEvidence } from '../types';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const URL_BASED_TYPES = ['link', 'receipt', 'shipping_confirmation', 'transaction_proof'];

export const linkNormalizer: EvidenceNormalizer = {
  name: 'link',
  supports: (e: RawEvidence) => URL_BASED_TYPES.includes(e.type) && !e.mimeType,
  async normalize(e: RawEvidence): Promise<NormalizedEvidence> {
    const res = await fetch(e.content);
    if (!res.ok) throw new Error(`Could not fetch evidence link ${e.content}: ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    const body = await res.text();
    const extractedText = contentType.includes('html') ? stripHtml(body) : body.trim();

    if (!extractedText) {
      throw new Error(`Fetched ${e.content} but found no readable text content.`);
    }

    return {
      id: e.id,
      kind: e.type,
      submittedBy: e.submittedBy,
      role: e.role as any,
      // Cap length to keep downstream prompt sizes sane — a very long page
      // (e.g. a full marketplace listing) shouldn't dominate the context.
      extractedText: extractedText.slice(0, 8000),
      mediaUrl: e.content,
      timestamp: e.createdAt.toISOString(),
      normalizerUsed: 'link-fetch',
    };
  },
};
