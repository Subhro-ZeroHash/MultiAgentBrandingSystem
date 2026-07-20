import type { AnswerEngine } from '@bmas/shared';
import type { AnswerEngineClient, EngineAnswer, EngineQuery } from '../engine.js';
import { NotImplementedError } from '../errors.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface OpenAiEngineConfig {
  apiKey: string | undefined;
  model?: string;
}

/**
 * ChatGPT-as-answer-engine probe.
 *
 * TODO(geo): implement against the Responses API with the hosted web-search
 * tool, and map `url_citation` annotations onto `AnswerCitation`. Left
 * unimplemented deliberately — the exact tool name and annotation shape are
 * part of the one-day provider spike (PRD Q4), and guessing them here would
 * bake a wrong contract into the scoring pipeline.
 */
export class OpenAiAnswerEngine implements AnswerEngineClient {
  readonly engine: AnswerEngine = 'chatgpt';

  constructor(private readonly config: OpenAiEngineConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async ask(_query: EngineQuery, _ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>> {
    throw new NotImplementedError('openai', 'ask');
  }
}
