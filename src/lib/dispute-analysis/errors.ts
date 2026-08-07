// src/lib/dispute-analysis/errors.ts

export class UnsupportedEvidenceError extends Error {
  constructor(public evidenceType: string) {
    super(`No normalizer registered for evidence type "${evidenceType}"`);
    this.name = 'UnsupportedEvidenceError';
  }
}

export class ProviderCapabilityError extends Error {
  constructor(public capability: string) {
    super(
      `No configured AI provider supports capability "${capability}". ` +
      `If this is "vision", that's expected for now — register a vision-capable ` +
      `provider in providers/registry.ts to enable image evidence analysis.`
    );
    this.name = 'ProviderCapabilityError';
  }
}
