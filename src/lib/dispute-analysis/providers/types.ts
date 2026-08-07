// src/lib/dispute-analysis/providers/types.ts
//
// Every AI provider (Groq today, anything vision-capable later) implements
// this interface. Nothing in normalizers/, stages/, or orchestrator.ts
// imports a concrete provider class directly — they all go through
// getProvider(capability) in registry.ts. Adding or swapping a provider
// means writing one new file here and adding one line to registry.ts.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderCapabilities {
  text: boolean;
  vision: boolean; // native image understanding — no provider sets this true yet
  pdf: boolean;     // native PDF understanding (distinct from our deterministic
                     // pdf-parse extraction, which doesn't need this capability)
}

export interface AIProvider {
  id: string; // e.g. "groq:llama-3.3-70b-versatile" — stored on DisputeAnalysis.provider
  capabilities: ProviderCapabilities;
  chatComplete(messages: ChatMessage[], opts?: { jsonMode?: boolean }): Promise<string>;
  describeImage?(imageUrl: string, prompt: string): Promise<string>;
}
