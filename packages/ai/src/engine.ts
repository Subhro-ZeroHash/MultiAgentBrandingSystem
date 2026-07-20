import type { AnswerEngine } from '@bmas/shared';
import type { ProviderContext, ProviderResult } from './types.js';

export interface AnswerCitation {
  url: string;
  title: string | null;
  /** 1-based order the engine listed the source in. */
  rank: number;
}

export interface EngineAnswer {
  engine: AnswerEngine;
  model: string;
  text: string;
  citations: AnswerCitation[];
  latencyMs: number;
}

export interface EngineQuery {
  prompt: string;
  /** Country code or city; ignored by engines without locale support. */
  locale?: string | null;
}

/**
 * GEO's counterpart to `ImageGenService`: one interface, one adapter per
 * generative engine we measure. Adding an engine must not touch probe or
 * scoring code.
 */
export interface AnswerEngineClient {
  readonly engine: AnswerEngine;

  /** True when credentials are present; probes skip unconfigured engines. */
  isConfigured(): boolean;

  ask(query: EngineQuery, ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>>;
}
