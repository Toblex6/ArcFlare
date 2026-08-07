// src/lib/dispute-analysis/providers/registry.ts
//
// THE extensibility point for AI providers. Callers never ask for a
// provider by name — they ask for a capability ("text", "vision") and get
// back whichever configured provider supports it. This is what lets you
// register a vision-capable provider later with zero changes to
// normalizers/, stages/, or orchestrator.ts.
//
// To add a new provider:
//   1. Implement AIProvider in a new file under providers/ (e.g. openai.ts).
//   2. Instantiate it (lazily, like getGroq() below) and add it to all().
// That's it — imageNormalizer already calls getProvider('vision') and will
// pick it up automatically once one exists.

import type { AIProvider, ProviderCapabilities } from './types';
import { GroqProvider } from './groq';
import { ProviderCapabilityError } from '../errors';

let groqInstance: GroqProvider | null = null;
function getGroq(): GroqProvider {
  if (!groqInstance) groqInstance = new GroqProvider();
  return groqInstance;
}

function all(): AIProvider[] {
  return [
    getGroq(),
    // ← add new providers here, e.g. getVisionProvider() once one exists
  ];
}

export function getProvider(capability: keyof ProviderCapabilities = 'text'): AIProvider {
  const match = all().find((p) => p.capabilities[capability]);
  if (!match) throw new ProviderCapabilityError(capability);
  return match;
}
