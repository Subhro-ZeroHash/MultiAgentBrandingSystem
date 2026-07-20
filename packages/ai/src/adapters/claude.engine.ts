import Anthropic from '@anthropic-ai/sdk';
import type { AnswerEngine } from '@bmas/shared';
import type { AnswerCitation, AnswerEngineClient, EngineAnswer, EngineQuery } from '../engine.js';
import { ProviderNotConfiguredError } from '../errors.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface ClaudeEngineConfig {
  apiKey: string | undefined;
  model?: string;
  maxSearches?: number;
}

/**
 * Probes Claude as an answer engine, with server-side web search enabled so the
 * answer reflects live retrieval rather than weights alone.
 *
 * Note on methodology: this measures the API surface of the model, which is not
 * byte-identical to what a consumer sees in the Claude app (different system
 * prompt, different tool config). Keep that caveat visible in the dashboard.
 */
export class ClaudeAnswerEngine implements AnswerEngineClient {
  readonly engine: AnswerEngine = 'claude';
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(private readonly config: ClaudeEngineConfig) {
    this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : null;
    this.model = config.model ?? 'claude-opus-4-8';
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async ask(query: EngineQuery, ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>> {
    if (!this.client) throw new ProviderNotConfiguredError('anthropic', 'ANTHROPIC_API_KEY');

    const startedAt = Date.now();
    const prompt = query.locale
      ? `${query.prompt}\n\n(Answering for: ${query.locale})`
      : query.prompt;

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: this.config.maxSearches ?? 5,
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: ctx?.signal },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const citations = extractCitations(response.content);
    const latencyMs = Date.now() - startedAt;

    return {
      value: { engine: this.engine, model: this.model, text, citations, latencyMs },
      cost: buildCostEvent({
        provider: 'anthropic',
        model: this.model,
        operation: 'geo:probe',
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
      }),
    };
  }
}

/**
 * Search results arrive as `web_search_tool_result` blocks. On error the block's
 * `content` is a single error object rather than a list — hence the array check.
 */
function extractCitations(content: readonly Anthropic.ContentBlock[]): AnswerCitation[] {
  const citations: AnswerCitation[] = [];
  const seen = new Set<string>();

  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = (block as { content?: unknown }).content;
    if (!Array.isArray(results)) continue;

    for (const result of results as Array<{ url?: string; title?: string }>) {
      if (!result.url || seen.has(result.url)) continue;
      seen.add(result.url);
      citations.push({ url: result.url, title: result.title ?? null, rank: citations.length + 1 });
    }
  }

  return citations;
}
