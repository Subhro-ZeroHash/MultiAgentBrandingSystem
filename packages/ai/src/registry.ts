import type { AnswerEngine } from '@bmas/shared';
import { AnthropicLlmAdapter } from './adapters/anthropic.llm.js';
import { ClaudeAnswerEngine } from './adapters/claude.engine.js';
import { FalImageAdapter } from './adapters/fal.image.js';
import { GeminiAnswerEngine } from './adapters/gemini.engine.js';
import { GeminiImageAdapter } from './adapters/gemini.image.js';
import { GeminiLlmAdapter } from './adapters/gemini.llm.js';
import { OpenAiAnswerEngine } from './adapters/openai.engine.js';
import { PerplexityAnswerEngine } from './adapters/perplexity.engine.js';
import { StubImageAdapter } from './adapters/stub.image.js';
import type { AnswerEngineClient } from './engine.js';
import type { ImageGenService } from './image.js';
import type { LlmService, ModelRole } from './llm.js';

/** `stub` draws placeholders locally — see adapters/stub.image.ts. */
export type ImageProviderName = 'gemini' | 'fal' | 'stub';

/** Which provider serves `LlmService` — text, JSON, and vision QA. */
export type LlmProviderName = 'anthropic' | 'gemini';

export interface AiConfig {
  anthropicApiKey?: string;
  googleApiKey?: string;
  falApiKey?: string;
  openaiApiKey?: string;
  perplexityApiKey?: string;

  /** Local-only API host overrides; see AnthropicAdapterConfig.baseUrl. */
  anthropicBaseUrl?: string;
  googleBaseUrl?: string;

  models?: Partial<Record<ModelRole, string>>;
  geminiImageModel?: string;
  falEditModel?: string;
  /** Artificial per-image latency for the stub adapter, ms. */
  stubImageLatencyMs?: number;

  /** Which adapter serves each image operation. */
  imageProviderPrimary?: ImageProviderName;
  imageProviderEdit?: ImageProviderName;
  /** Which adapter serves text/JSON/vision. Defaults to `anthropic`. */
  llmProvider?: LlmProviderName;
}

const ANTHROPIC_MODELS: Record<ModelRole, string> = {
  // Reasoning-heavy orchestration: brief composition, GEO answer analysis.
  orchestrator: 'claude-opus-4-8',
  // High fan-out, latency-sensitive: per-platform copy variants.
  volume: 'claude-haiku-4-5',
  // Judgement calls: vision QA readback on rendered creatives.
  qa: 'claude-sonnet-5',
};

/**
 * Confirmed live via ListModels + a real generateContent call on 2026-07-25.
 * Worth re-checking: Google retires these fast, and the whole 2.5 family plus
 * `gemini-3-pro-preview` already answer 404 "no longer available to new users"
 * despite still being listed — ListModels alone is not proof a model is usable.
 * `gemini-3.1-pro-preview` is the only Pro tier still accepting new users.
 */
const GEMINI_MODELS: Record<ModelRole, string> = {
  orchestrator: 'gemini-3.1-pro-preview',
  volume: 'gemini-3.6-flash',
  qa: 'gemini-3.6-flash',
};

const DEFAULT_MODELS: Record<LlmProviderName, Record<ModelRole, string>> = {
  anthropic: ANTHROPIC_MODELS,
  gemini: GEMINI_MODELS,
};

/**
 * Single place that decides which adapter serves which operation. Swapping a
 * provider is a config change here, never an edit in product code.
 */
export class AiRegistry {
  private readonly llmService: LlmService;
  private readonly images: Record<ImageProviderName, ImageGenService>;
  private readonly engines: Map<AnswerEngine, AnswerEngineClient>;

  constructor(private readonly config: AiConfig) {
    // LLM_MODEL_* overrides are provider-agnostic strings, so they must match
    // whichever provider is selected — a Claude id under LLM_PROVIDER=gemini
    // reaches Google and 404s. Defaults are picked per provider for that reason.
    const llmProvider = config.llmProvider ?? 'anthropic';
    const models = { ...DEFAULT_MODELS[llmProvider], ...config.models };

    this.llmService =
      llmProvider === 'gemini'
        ? new GeminiLlmAdapter({
            apiKey: config.googleApiKey,
            models,
            ...(config.googleBaseUrl ? { baseUrl: config.googleBaseUrl } : {}),
          })
        : new AnthropicLlmAdapter({
            apiKey: config.anthropicApiKey,
            models,
            ...(config.anthropicBaseUrl ? { baseUrl: config.anthropicBaseUrl } : {}),
          });

    this.images = {
      gemini: new GeminiImageAdapter({
        apiKey: config.googleApiKey,
        model: config.geminiImageModel,
        ...(config.googleBaseUrl ? { baseUrl: config.googleBaseUrl } : {}),
      }),
      fal: new FalImageAdapter({ apiKey: config.falApiKey, editModel: config.falEditModel }),
      ...(config.stubImageLatencyMs === undefined
        ? { stub: new StubImageAdapter() }
        : { stub: new StubImageAdapter({ latencyMs: config.stubImageLatencyMs }) }),
    };

    this.engines = new Map<AnswerEngine, AnswerEngineClient>([
      ['claude', new ClaudeAnswerEngine({ apiKey: config.anthropicApiKey })],
      ['perplexity', new PerplexityAnswerEngine({ apiKey: config.perplexityApiKey })],
      ['chatgpt', new OpenAiAnswerEngine({ apiKey: config.openaiApiKey })],
      ['gemini', new GeminiAnswerEngine({ apiKey: config.googleApiKey })],
    ]);
  }

  llm(): LlmService {
    return this.llmService;
  }

  /** Image generation for the fan-out of fresh variants. */
  imageGenerator(): ImageGenService {
    return this.images[this.config.imageProviderPrimary ?? 'gemini'];
  }

  /** Targeted edits; routed separately so edits can use a specialised model. */
  imageEditor(): ImageGenService {
    return this.images[this.config.imageProviderEdit ?? 'fal'];
  }

  answerEngine(engine: AnswerEngine): AnswerEngineClient | undefined {
    return this.engines.get(engine);
  }

  /** Engines with credentials present — probes skip everything else. */
  configuredEngines(): AnswerEngineClient[] {
    return [...this.engines.values()].filter((client) => client.isConfigured());
  }
}

/** Builds the registry from `process.env`. Called once at app bootstrap. */
export function createAiRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): AiRegistry {
  return new AiRegistry({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    googleApiKey: env.GOOGLE_API_KEY,
    falApiKey: env.FAL_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    perplexityApiKey: env.PERPLEXITY_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { anthropicBaseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.GOOGLE_API_BASE_URL ? { googleBaseUrl: env.GOOGLE_API_BASE_URL } : {}),
    models: {
      ...(env.LLM_MODEL_ORCHESTRATOR ? { orchestrator: env.LLM_MODEL_ORCHESTRATOR } : {}),
      ...(env.LLM_MODEL_VOLUME ? { volume: env.LLM_MODEL_VOLUME } : {}),
      ...(env.LLM_MODEL_QA ? { qa: env.LLM_MODEL_QA } : {}),
    },
    geminiImageModel: env.IMAGE_MODEL_GEMINI,
    falEditModel: env.IMAGE_MODEL_FAL_EDIT,
    ...(env.IMAGE_STUB_LATENCY_MS
      ? { stubImageLatencyMs: Number(env.IMAGE_STUB_LATENCY_MS) }
      : {}),
    imageProviderPrimary: env.IMAGE_PROVIDER_PRIMARY as ImageProviderName | undefined,
    imageProviderEdit: env.IMAGE_PROVIDER_EDIT as ImageProviderName | undefined,
    llmProvider: env.LLM_PROVIDER as LlmProviderName | undefined,
  });
}
