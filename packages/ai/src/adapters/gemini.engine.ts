import type { AnswerEngine } from '@bmas/shared';
import type { AnswerCitation, AnswerEngineClient, EngineAnswer, EngineQuery } from '../engine.js';
import { ProviderError, ProviderNotConfiguredError } from '../errors.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface GeminiEngineConfig {
  apiKey: string | undefined;
  model?: string;
  baseUrl?: string;
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
}

/**
 * Gemini-as-answer-engine probe, via the Generative Language REST API with the
 * Google Search grounding tool. Raw `fetch` rather than `@google/genai` for the
 * same reason the Perplexity adapter does it: what we care about is the
 * grounding metadata, and hand-rolling the request keeps that shape visible
 * instead of behind a wrapper that may narrow it.
 *
 * Grounding is what makes this a measurement of an *answer engine* rather than
 * of a language model — without the tool, Gemini answers from parametric memory
 * and the citation rate is meaninglessly zero.
 */
export class GeminiAnswerEngine implements AnswerEngineClient {
  readonly engine: AnswerEngine = 'gemini';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: GeminiEngineConfig) {
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    // `gemini-2.5-flash` (verified live 2026-07-21) was retired for new users
    // sometime before 2026-08-13 — confirmed via GET /v1beta/models, which no
    // longer serves it. `-latest` is Google's own floating alias for exactly
    // this: it survives point-release retirements without a code change here.
    // Still blocked independently by GOOGLE_API_KEY's account having zero
    // prepayment credits (every generateContent call 402s, grounded or not,
    // confirmed 2026-08-13) — that is a billing problem, not a model-id one,
    // and no model swap here fixes it. Revisit once billing is enabled.
    this.model = config.model ?? 'gemini-flash-latest';
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async ask(query: EngineQuery, ctx?: ProviderContext): Promise<ProviderResult<EngineAnswer>> {
    if (!this.config.apiKey) {
      throw new ProviderNotConfiguredError('google', 'GOOGLE_API_KEY');
    }

    const startedAt = Date.now();
    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query.prompt }] }],
          // `locale` is deliberately not forwarded: generateContent has no
          // user-location parameter, and folding the locale into the prompt
          // text would change the question we are measuring the answer to.
          tools: [{ google_search: {} }],
        }),
        signal: ctx?.signal,
      },
    );

    if (!response.ok) {
      throw new ProviderError(
        `Gemini returned ${response.status}: ${await response.text()}`,
        'google',
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = (await response.json()) as GeminiResponse;
    const latencyMs = Date.now() - startedAt;
    const candidate = body.candidates?.[0];

    return {
      value: {
        engine: this.engine,
        model: body.modelVersion ?? this.model,
        // Thinking parts arrive alongside answer parts and carry no `text`.
        text: (candidate?.content?.parts ?? [])
          .map((part) => part.text ?? '')
          .join('')
          .trim(),
        citations: toCitations(candidate?.groundingMetadata?.groundingChunks ?? []),
        latencyMs,
      },
      cost: buildCostEvent({
        provider: 'google',
        model: this.model,
        operation: 'geo:probe',
        // Grounded calls bill for the search turn and the thinking budget on top
        // of the visible answer, so both are folded in rather than dropped.
        inputTokens:
          (body.usageMetadata?.promptTokenCount ?? 0) +
          (body.usageMetadata?.toolUsePromptTokenCount ?? 0),
        outputTokens:
          (body.usageMetadata?.candidatesTokenCount ?? 0) +
          (body.usageMetadata?.thoughtsTokenCount ?? 0),
        latencyMs,
        // TODO(geo): no Gemini entry in TOKEN_RATES yet, so this lands as 0 and
        // understates spend. Needs confirmed list pricing, plus whatever the
        // grounding tool is billed at per call — see PRD §Q4.
        costMicroUsd: 0,
      }),
    };
  }
}

/**
 * Grounding chunks do NOT carry the publisher URL. `web.uri` is an opaque
 * vertexaisearch.cloud.google.com redirect, and the real domain arrives in
 * `web.title` (e.g. "sacredweaves.com"). Citation matching against a brand's
 * domain must therefore read `title`, not `url` — matching on `url` silently
 * matches nothing, which would look like a brand that is never cited.
 */
function toCitations(chunks: GeminiGroundingChunk[]): AnswerCitation[] {
  return chunks
    .filter((chunk) => chunk.web?.uri)
    .map((chunk, index) => ({
      url: chunk.web?.uri ?? '',
      title: chunk.web?.title ?? null,
      rank: index + 1,
    }));
}
