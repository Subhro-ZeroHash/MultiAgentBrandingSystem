import type { AnswerEngine } from '@bmas/shared';
import type { AnswerCitation, AnswerEngineClient, EngineAnswer, EngineQuery } from '../engine.js';
import { ProviderError, ProviderNotConfiguredError } from '../errors.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface PerplexityEngineConfig {
  apiKey: string | undefined;
  model?: string;
  baseUrl?: string;
}

interface PerplexityResponse {
  choices: Array<{ message: { content: string } }>;
  citations?: string[];
  search_results?: Array<{ url: string; title?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Perplexity exposes an OpenAI-compatible chat endpoint plus a `citations`
 * array — the cleanest citation signal of any engine we probe, which is why
 * this adapter uses `fetch` directly rather than the OpenAI SDK (the SDK
 * discards the non-standard fields we care about).
 */
export class PerplexityAnswerEngine implements AnswerEngineClient {
  readonly engine: AnswerEngine = 'perplexity';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: PerplexityEngineConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.perplexity.ai';
    this.model = config.model ?? 'sonar';
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async ask(query: EngineQuery, ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>> {
    if (!this.config.apiKey) {
      throw new ProviderNotConfiguredError('perplexity', 'PERPLEXITY_API_KEY');
    }

    const startedAt = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: query.prompt }],
        ...(query.locale
          ? { web_search_options: { user_location: { country: query.locale } } }
          : {}),
      }),
      signal: ctx?.signal,
    });

    if (!response.ok) {
      throw new ProviderError(
        `Perplexity returned ${response.status}: ${await response.text()}`,
        'perplexity',
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = (await response.json()) as PerplexityResponse;
    const latencyMs = Date.now() - startedAt;

    return {
      value: {
        engine: this.engine,
        model: this.model,
        text: body.choices?.[0]?.message.content ?? '',
        citations: toCitations(body),
        latencyMs,
      },
      cost: buildCostEvent({
        provider: 'perplexity',
        model: this.model,
        operation: 'geo:probe',
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
        latencyMs,
        // No rate table entry for `sonar` in TOKEN_RATES yet (pricing needs to
        // be confirmed against the live API, not guessed — see CLAUDE.md), so
        // this understates spend at 0 until one is added. Left unset rather
        // than pinned to a hardcoded `costMicroUsd: 0`: pinning it silently
        // keeps this row at 0 forever even after a real rate is added, since
        // buildCostEvent prefers an explicit costMicroUsd over computing one.
      }),
    };
  }
}

function toCitations(body: PerplexityResponse): AnswerCitation[] {
  if (body.search_results?.length) {
    return body.search_results.map((result, index) => ({
      url: result.url,
      title: result.title ?? null,
      rank: index + 1,
    }));
  }

  return (body.citations ?? []).map((url, index) => ({ url, title: null, rank: index + 1 }));
}
