import type { AnswerEngine } from '@bmas/shared';
import type { AnswerEngineClient, EngineAnswer, EngineQuery } from '../engine.js';
import { NotImplementedError } from '../errors.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface GeminiEngineConfig {
  apiKey: string | undefined;
  model?: string;
}

/**
 * Gemini-as-answer-engine probe.
 *
 * TODO(geo): implement with the Google Search grounding tool and read citations
 * off `groundingMetadata.groundingChunks`. Unimplemented pending the provider
 * spike — see openai.engine.ts for the same rationale.
 */
export class GeminiAnswerEngine implements AnswerEngineClient {
  readonly engine: AnswerEngine = 'gemini';

  constructor(private readonly config: GeminiEngineConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async ask(_query: EngineQuery, _ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>> {
    throw new NotImplementedError('google', 'ask');
  }
}
