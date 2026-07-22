import { NotImplementedError, ProviderError, ProviderNotConfiguredError } from '../errors.js';
import type {
  LlmJsonRequest,
  LlmService,
  LlmTextRequest,
  LlmVisionRequest,
} from '../llm.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface GeminiLlmConfig {
  apiKey: string | undefined;
  model?: string;
  baseUrl?: string;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

/**
 * Gemini as a general text/JSON LLM, distinct from the Gemini *answer engine*
 * (gemini.engine.ts): no grounding tool, just structured extraction.
 *
 * This exists as a stopgap so the GEO analyser can run on a Google key alone,
 * before an Anthropic key is provisioned. It is opt-in via `LLM_PROVIDER=gemini`
 * and the registry still defaults to Anthropic, so the content workstream's use
 * of `ai.llm()` is unaffected. Raw `fetch`, like the other Gemini adapter, keeps
 * the request shape visible and avoids pulling in an SDK.
 *
 * Roles (`orchestrator` / `volume` / `qa`) collapse to a single model here: the
 * role→model map is Anthropic-specific, and for a one-model stopgap a tier
 * distinction would be pretend precision. Revisit if this outlives "for now".
 */
export class GeminiLlmAdapter implements LlmService {
  readonly provider = 'google';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: GeminiLlmConfig) {
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    // 2.5-flash grounds and extracts fine on a free-tier key; the 3.x line is
    // paid-only for the tool paths. See gemini.engine.ts for the same note.
    this.model = config.model ?? 'gemini-2.5-flash';
  }

  private key(): string {
    if (!this.config.apiKey) throw new ProviderNotConfiguredError('google', 'GOOGLE_API_KEY');
    return this.config.apiKey;
  }

  async generateText(req: LlmTextRequest, ctx?: ProviderContext): Promise<ProviderResult<string>> {
    const { text, body, latencyMs } = await this.call(
      { system: req.system, messages: req.messages, maxTokens: req.maxTokens },
      ctx,
    );
    return { value: text, cost: this.cost(body, `text:${req.role}`, latencyMs) };
  }

  async generateJson<T>(req: LlmJsonRequest<T>, ctx?: ProviderContext): Promise<ProviderResult<T>> {
    // The schema travels as instruction, not as a hard `responseSchema`: Gemini's
    // schema dialect differs from the JSON Schema our callers write (no
    // additionalProperties, `nullable` not `type: [..., 'null']`), so forcing it
    // would reject valid callers. `responseMimeType` still guarantees the output
    // parses as JSON; correctness of the shape rides on the instruction + the
    // caller's own `parse`.
    const system = [
      req.system ?? '',
      '',
      'Return ONLY a JSON value conforming to this JSON Schema. No prose, no markdown fences:',
      JSON.stringify(req.schema),
    ]
      .join('\n')
      .trim();

    const { text, body, latencyMs } = await this.call(
      {
        system,
        messages: req.messages,
        maxTokens: req.maxTokens,
        responseMimeType: 'application/json',
      },
      ctx,
    );

    return {
      value: req.parse(JSON.parse(stripFences(text))),
      cost: this.cost(body, `json:${req.role}`, latencyMs),
    };
  }

  analyzeImage(_req: LlmVisionRequest, _ctx?: ProviderContext): Promise<ProviderResult<string>> {
    // Only the content QA pass calls this, and content does not run on the Gemini
    // LLM backend. Wire Gemini vision here if that ever changes.
    throw new NotImplementedError('google', 'analyzeImage');
  }

  private async call(
    args: {
      system?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
      responseMimeType?: string;
    },
    ctx?: ProviderContext,
  ): Promise<{ text: string; body: GeminiGenerateResponse; latencyMs: number }> {
    const startedAt = Date.now();
    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.key()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(args.system ? { systemInstruction: { parts: [{ text: args.system }] } } : {}),
          contents: args.messages.map((m) => ({
            // Gemini names the assistant turn 'model', not 'assistant'.
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            maxOutputTokens: args.maxTokens ?? 4096,
            ...(args.responseMimeType ? { responseMimeType: args.responseMimeType } : {}),
          },
        }),
        signal: ctx?.signal,
      },
    );

    if (!response.ok) {
      throw new ProviderError(
        `Gemini LLM returned ${response.status}: ${await response.text()}`,
        'google',
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = (await response.json()) as GeminiGenerateResponse;
    if (body.promptFeedback?.blockReason) {
      throw new ProviderError(
        `Gemini blocked the prompt: ${body.promptFeedback.blockReason}`,
        'google',
        { retryable: false },
      );
    }

    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      // A truncated MAX_TOKENS response or an all-thinking candidate lands here.
      throw new ProviderError(
        `Gemini returned no text (finishReason: ${body.candidates?.[0]?.finishReason ?? 'unknown'})`,
        'google',
        { retryable: true },
      );
    }

    return { text, body, latencyMs: Date.now() - startedAt };
  }

  private cost(body: GeminiGenerateResponse, operation: string, latencyMs: number) {
    return buildCostEvent({
      provider: 'google',
      model: this.model,
      operation,
      inputTokens: body.usageMetadata?.promptTokenCount,
      outputTokens:
        (body.usageMetadata?.candidatesTokenCount ?? 0) +
        (body.usageMetadata?.thoughtsTokenCount ?? 0),
      latencyMs,
      // TODO(geo): no Gemini row in TOKEN_RATES, so this lands as 0. Same gap as
      // the answer-engine adapter — needs confirmed list pricing.
      costMicroUsd: 0,
    });
  }
}

/** Defensive: strip ```json fences if the model adds them despite instructions. */
function stripFences(text: string): string {
  const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fenced?.[1] ?? text;
}
