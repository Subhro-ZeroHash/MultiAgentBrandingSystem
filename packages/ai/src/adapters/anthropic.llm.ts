import Anthropic from '@anthropic-ai/sdk';
import { ProviderNotConfiguredError, ProviderError } from '../errors.js';
import type {
  LlmJsonRequest,
  LlmService,
  LlmTextRequest,
  LlmVisionRequest,
  ModelRole,
} from '../llm.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface AnthropicAdapterConfig {
  apiKey: string | undefined;
  models: Record<ModelRole, string>;
}

/**
 * The only place `@anthropic-ai/sdk` is imported. Everything else goes through
 * `LlmService`.
 */
export class AnthropicLlmAdapter implements LlmService {
  readonly provider = 'anthropic';
  private readonly client: Anthropic | null;

  constructor(private readonly config: AnthropicAdapterConfig) {
    this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : null;
  }

  private require(): Anthropic {
    if (!this.client) throw new ProviderNotConfiguredError('anthropic', 'ANTHROPIC_API_KEY');
    return this.client;
  }

  private modelFor(role: ModelRole): string {
    return this.config.models[role];
  }

  async generateText(req: LlmTextRequest, ctx?: ProviderContext): Promise<ProviderResult<string>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    const response = await this.require().messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? 4096,
        // Adaptive thinking is the current mode on Claude 4.6+; depth is
        // controlled by `effort`, not a token budget.
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort ?? 'medium' },
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
      },
      { signal: ctx?.signal },
    );

    if (response.stop_reason === 'refusal') {
      throw new ProviderError('Request was declined by safety classifiers', 'anthropic', {
        retryable: false,
      });
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      value: text,
      cost: buildCostEvent({
        provider: 'anthropic',
        model,
        operation: `text:${req.role}`,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async generateJson<T>(req: LlmJsonRequest<T>, ctx?: ProviderContext): Promise<ProviderResult<T>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    const response = await this.require().messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? 4096,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: req.effort ?? 'medium',
          format: { type: 'json_schema', schema: req.schema },
        },
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
      },
      { signal: ctx?.signal },
    );

    if (response.stop_reason === 'refusal') {
      throw new ProviderError('Request was declined by safety classifiers', 'anthropic', {
        retryable: false,
      });
    }

    const raw = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    )?.text;

    if (!raw) {
      throw new ProviderError('Model returned no text block for a JSON request', 'anthropic', {
        retryable: true,
      });
    }

    return {
      value: req.parse(JSON.parse(raw)),
      cost: buildCostEvent({
        provider: 'anthropic',
        model,
        operation: `json:${req.role}`,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async analyzeImage(
    req: LlmVisionRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<string>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    const response = await this.require().messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? 2048,
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort ?? 'medium' },
        ...(req.system ? { system: req.system } : {}),
        messages: [
          {
            role: 'user',
            content: [
              ...req.images.map((image) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: image.mediaType,
                  data: image.data.toString('base64'),
                },
              })),
              { type: 'text' as const, text: req.prompt },
            ],
          },
        ],
      },
      { signal: ctx?.signal },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      value: text,
      cost: buildCostEvent({
        provider: 'anthropic',
        model,
        operation: 'vision',
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
