import { GoogleGenAI } from '@google/genai';
import { ProviderError, ProviderNotConfiguredError, describeError } from '../errors.js';
import type {
  LlmJsonRequest,
  LlmService,
  LlmTextRequest,
  LlmVisionRequest,
  ModelRole,
} from '../llm.js';
import { buildCostEvent } from '../pricing.js';
import { isQuotaExhausted, isRetryable } from '../resilience.js';
import type { ProviderContext, ProviderResult } from '../types.js';

/** Text and vision calls are far quicker than image generation; see the image
 *  adapter for why an explicit ceiling matters at all. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface GeminiLlmConfig {
  apiKey: string | undefined;
  models: Record<ModelRole, string>;
  /** Overrides the API host. Unset in every deployed environment; exists so
   *  local development and CI can point at a mock and exercise this adapter's
   *  real request/response handling without credentials or spend. */
  baseUrl?: string;
}

/**
 * Text/vision LLM served by Gemini, so a deployment can run the whole content
 * pipeline on a single Google credential instead of holding an Anthropic key
 * as well. Selected by `LLM_PROVIDER=gemini`; see AiRegistry.
 *
 * This and `gemini.image.ts` are the only places `@google/genai` is imported.
 *
 * `effort` is accepted but deliberately not mapped onto Gemini's
 * `thinkingConfig`. The obvious mapping (`low` -> `thinkingBudget: 0`) is
 * rejected outright by the Pro tier, which cannot disable thinking, so a
 * mis-mapping would fail at request time on exactly the role most likely to ask
 * for it. Letting each model apply its own default is the safe behaviour until
 * the mapping can be checked against live models per role.
 *
 * As in the image adapter, retries are not applied here — callers wrap this in
 * `withRetry` and nesting the two multiplies the attempt count. What this owes
 * the caller is accurate `retryable` classification.
 */
export class GeminiLlmAdapter implements LlmService {
  readonly provider = 'google';
  private readonly client: GoogleGenAI | null;

  constructor(private readonly config: GeminiLlmConfig) {
    this.client = config.apiKey
      ? new GoogleGenAI({
          apiKey: config.apiKey,
          httpOptions: {
            timeout: REQUEST_TIMEOUT_MS,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          },
        })
      : null;
  }

  private require(): GoogleGenAI {
    if (!this.client) throw new ProviderNotConfiguredError('google', 'GOOGLE_API_KEY');
    return this.client;
  }

  private modelFor(role: ModelRole): string {
    return this.config.models[role];
  }

  /** Same classification rule as the image adapter: a 429 from a burst clears
   *  in seconds, a 429 carrying `limit: 0` never will. */
  private static wrap(error: unknown, operation: string): ProviderError {
    if (error instanceof ProviderError) return error;
    // See the image adapter: `.message` alone loses the transport failure.
    const message = describeError(error);

    if (isQuotaExhausted(error)) {
      return new ProviderError(
        `google.${operation}: quota exhausted (limit: 0) — the project has no allocation, ` +
          `so retrying will not help. ${message}`,
        'google',
        { retryable: false, cause: error },
      );
    }

    return new ProviderError(`google.${operation}: ${message}`, 'google', {
      retryable: isRetryable(error),
      cause: error,
    });
  }

  /** Gemini names the assistant turn `model`; everything else maps across. */
  private static contents(messages: LlmTextRequest['messages']) {
    return messages.map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: message.content }],
    }));
  }

  /**
   * Thinking tokens are billed at the output rate but reported separately, so
   * they are folded into `outputTokens` — otherwise every reasoning-heavy call
   * under-reports its cost in `core.cost_events`.
   */
  private static usageOf(usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  }) {
    const cachedInputTokens = usage?.cachedContentTokenCount ?? 0;
    return {
      // Unlike Anthropic (where `input_tokens` and `cache_read_input_tokens`
      // are separate, additive counts), Gemini's `promptTokenCount` already
      // includes the cached portion. `priceTokens` charges inputTokens and
      // cachedInputTokens additively, so passing the raw total here would
      // double-bill every cached token; subtract it out first.
      inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cachedInputTokens),
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cachedInputTokens,
    };
  }

  /** Concatenates the text parts of the first candidate. */
  private static textOf(response: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }): string {
    return (response.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => Boolean(text))
      .join('');
  }

  async generateText(req: LlmTextRequest, ctx?: ProviderContext): Promise<ProviderResult<string>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    let response;
    try {
      response = await this.require().models.generateContent({
        model,
        contents: GeminiLlmAdapter.contents(req.messages),
        config: {
          maxOutputTokens: req.maxTokens ?? 4096,
          ...(req.system ? { systemInstruction: req.system } : {}),
          ...(ctx?.signal ? { abortSignal: ctx.signal } : {}),
        },
      });
    } catch (error) {
      throw GeminiLlmAdapter.wrap(error, `text:${req.role}`);
    }

    return {
      value: GeminiLlmAdapter.textOf(response),
      cost: buildCostEvent({
        provider: this.provider,
        model,
        operation: `text:${req.role}`,
        ...GeminiLlmAdapter.usageOf(response.usageMetadata),
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async generateJson<T>(req: LlmJsonRequest<T>, ctx?: ProviderContext): Promise<ProviderResult<T>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    let response;
    try {
      response = await this.require().models.generateContent({
        model,
        contents: GeminiLlmAdapter.contents(req.messages),
        config: {
          maxOutputTokens: req.maxTokens ?? 4096,
          // responseJsonSchema requires responseMimeType and forbids the older
          // responseSchema; it takes JSON Schema, which is what callers hold.
          responseMimeType: 'application/json',
          responseJsonSchema: req.schema,
          ...(req.system ? { systemInstruction: req.system } : {}),
          ...(ctx?.signal ? { abortSignal: ctx.signal } : {}),
        },
      });
    } catch (error) {
      throw GeminiLlmAdapter.wrap(error, `json:${req.role}`);
    }

    const raw = GeminiLlmAdapter.textOf(response);
    if (!raw) {
      throw new ProviderError('Model returned no text for a JSON request', 'google', {
        retryable: true,
      });
    }

    // Constrained decoding can still be cut short by maxOutputTokens, which
    // yields valid-looking but truncated JSON. Retryable: a rerun usually fits.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ProviderError(
        `google.json:${req.role}: response was not valid JSON — ${raw.slice(0, 200)}`,
        'google',
        { retryable: true, cause: error },
      );
    }

    return {
      value: req.parse(parsed),
      cost: buildCostEvent({
        provider: this.provider,
        model,
        operation: `json:${req.role}`,
        ...GeminiLlmAdapter.usageOf(response.usageMetadata),
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async analyzeImage(req: LlmVisionRequest, ctx?: ProviderContext): Promise<ProviderResult<string>> {
    const model = this.modelFor(req.role);
    const startedAt = Date.now();

    // Images lead, instruction last — the model reads them as context for the
    // prompt that follows, matching how the image adapter orders references.
    const parts = [
      ...req.images.map((image) => ({
        inlineData: { mimeType: image.mediaType, data: image.data.toString('base64') },
      })),
      { text: req.prompt },
    ];

    let response;
    try {
      response = await this.require().models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          maxOutputTokens: req.maxTokens ?? 2048,
          ...(req.system ? { systemInstruction: req.system } : {}),
          ...(ctx?.signal ? { abortSignal: ctx.signal } : {}),
        },
      });
    } catch (error) {
      throw GeminiLlmAdapter.wrap(error, 'vision');
    }

    return {
      value: GeminiLlmAdapter.textOf(response),
      cost: buildCostEvent({
        provider: this.provider,
        model,
        operation: 'vision',
        ...GeminiLlmAdapter.usageOf(response.usageMetadata),
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
