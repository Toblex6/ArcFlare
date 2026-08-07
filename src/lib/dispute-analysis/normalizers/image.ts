// src/lib/dispute-analysis/normalizers/image.ts
//
// EXTENSION POINT — inactive by design until a vision-capable AIProvider is
// registered in providers/registry.ts. Per the decision to optimize for
// text/URL evidence first, image evidence is recognized (so it shows up in
// evidenceCoverage.failed with a clear reason) but not yet processed.
//
// Once a provider with capabilities.vision = true exists, this normalizer
// activates automatically — getProvider('vision') will resolve to it and
// describeImage() will run. No changes needed here or in the orchestrator.

import type { EvidenceNormalizer } from './types';
import type { RawEvidence, NormalizedEvidence } from '../types';
import { getProvider } from '../providers/registry';

export const imageNormalizer: EvidenceNormalizer = {
  name: 'image',
  supports: (e: RawEvidence) =>
    e.type === 'image' || e.type === 'screenshot' || (e.mimeType?.startsWith('image/') ?? false),
  async normalize(e: RawEvidence): Promise<NormalizedEvidence> {
    // Throws ProviderCapabilityError until a vision provider is registered —
    // caught by orchestrator's Promise.allSettled and surfaced per-item in
    // evidenceCoverage.failed, not a pipeline-wide crash.
    const provider = getProvider('vision');
    if (!provider.describeImage) {
      throw new Error(`Provider ${provider.id} claims vision support but has no describeImage() implementation.`);
    }

    const description = await provider.describeImage(
      e.content,
      'Describe this image in detail as evidence for a payment dispute. Note any visible text, dates, amounts, names, or timestamps exactly as shown.'
    );

    return {
      id: e.id,
      kind: e.type,
      submittedBy: e.submittedBy,
      role: e.role as any,
      extractedText: description,
      mediaUrl: e.content,
      timestamp: e.createdAt.toISOString(),
      normalizerUsed: `vision:${provider.id}`,
    };
  },
};
