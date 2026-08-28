// src/lib/dispute-analysis/providers/groq.ts
//
// Text-only provider. Mirrors the fetch/error-handling shape already proven
// in agent-brain's runBrain() (same endpoint, same "unwrap res.ok, throw a
// clean Error" pattern) — no tool-calling loop needed here, this is a
// single-shot completion per pipeline stage.

import type { AIProvider, ChatMessage, ProviderCapabilities } from './types';

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

export class GroqProvider implements AIProvider {
  id = `groq:${GROQ_MODEL}`;
  capabilities: ProviderCapabilities = { text: true, vision: false, pdf: false };

  async chatComplete(messages: ChatMessage[], opts?: { jsonMode?: boolean }): Promise<string> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not configured on the server.');
    }

    let res: Response;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.1,
          max_tokens: 2048,
          messages,
          ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (fetchErr: any) {
      throw new Error(`Could not reach Groq: ${fetchErr?.message || 'network error'}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Groq returned no usable content.');
    }
    return content;
  }
}
