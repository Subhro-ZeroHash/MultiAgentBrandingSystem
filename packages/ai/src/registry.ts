import type { AnswerEngine } from '@bmas/shared';
import { AnthropicLlmAdapter } from './adapters/anthropic.llm.js';
import { ClaudeAnswerEngine } from './adapters/claude.engine.js';
import { FalImageAdapter } from './adapters/fal.image.js';
import { GeminiAnswerEngine } from './adapters/gemini.engine.js';
import { GeminiImageAdapter } from './adapters/gemini.image.js';
import { GeminiLlmAdapter } from './adapters/gemini.llm.js';
import { GeminiVideoAdapter } from './adapters/gemini.video.js';
import { LtxVideoAdapter } from './adapters/ltx.video.js';
import { OpenAiAnswerEngine } from './adapters/openai.engine.js';
import { PerplexityAnswerEngine } from './adapters/perplexity.engine.js';
import { SerpApiSearchAdapter } from './adapters/serpapi.search.js';
import { StubImageAdapter } from './adapters/stub.image.js';
import { StubSearchAdapter } from './adapters/stub.search.js';
import { StubVideoAdapter } from './adapters/stub.video.js';
import { TavilySearchAdapter } from './adapters/tavily.search.js';
import type { AnswerEngineClient } from './engine.js';
import type { ImageGenService } from './image.js';
import type { LlmService, ModelRole } from './llm.js';
import type { WebSearchService } from './search.js';
import type { VideoGenService } from './video.js';

/** `stub` draws placeholders locally — see adapters/stub.image.ts. `gemini` is
 *  the primary content-generation provider. */
export type ImageProviderName = 'gemini' | 'fal' | 'stub';

/** `stub` draws placeholders locally — see adapters/stub.video.ts. `ltx` is
 *  the configured default; `google` (Veo, via the same SDK/key the image
 *  adapter already uses) is a direct, caller-selectable alternative, not a
 *  fallback — see `videoGenerator()`'s optional argument and
 *  `PROVIDER_FOR_MODE` in generate-video.ts, which picks one deterministically
 *  from the request's `videoMode`. */
export type VideoProviderName = 'ltx' | 'google' | 'stub';

/** Which provider serves `LlmService` — text, JSON, and vision QA. */
export type LlmProviderName = 'anthropic' | 'gemini';

/** `stub` returns fixture results locally — see adapters/stub.search.ts. */
export type SearchProviderName = 'tavily' | 'serpapi' | 'stub';

export interface AiConfig {
  anthropicApiKey?: string;
  googleApiKey?: string;
  falApiKey?: string;
  openaiApiKey?: string;
  perplexityApiKey?: string;
  tavilyApiKey?: string;
  serpApiKey?: string;
  ltxApiKey?: string;

  /** Local-only API host overrides; see AnthropicAdapterConfig.baseUrl. */
  anthropicBaseUrl?: string;
  googleBaseUrl?: string;

  models?: Partial<Record<ModelRole, string>>;
  geminiImageModel?: string;
  falEditModel?: string;
  ltxModel?: string;
  ltxBaseUrl?: string;
  /**
   * Model the Gemini *answer engine* asks during a GEO probe — distinct from
   * both the image model and the LLM role models. Grounded calls on the 3.x
   * line are paid-tier only, so a free key has to pin an older grounded model
   * here without dragging the rest of the registry back with it.
   */
  geminiEngineModel?: string;
  /** Artificial per-image latency for the stub adapter, ms. */
  stubImageLatencyMs?: number;

  /** Which adapter serves each image operation. */
  imageProviderPrimary?: ImageProviderName;
  imageProviderEdit?: ImageProviderName;
  /** Which adapter serves `videoGenerator()`. Defaults to `ltx`. */
  videoProviderPrimary?: VideoProviderName;
  /** Which adapter serves text/JSON/vision. Defaults to `anthropic`. */
  llmProvider?: LlmProviderName;
  /** Which adapter serves `webSearch()`. Defaults to `tavily`; an unset
   *  TAVILY_API_KEY surfaces as ProviderNotConfiguredError at call time, the
   *  same failure mode every other unconfigured adapter already has. */
  searchProvider?: SearchProviderName;
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
  private readonly videos: Record<VideoProviderName, VideoGenService>;
  private readonly engines: Map<AnswerEngine, AnswerEngineClient>;
  private readonly searches: Record<SearchProviderName, WebSearchService>;

  constructor(private readonly config: AiConfig) {
    // LLM_MODEL_* overrides are provider-agnostic strings, so they must match
    // whichever provider is selected — a Claude id under LLM_PROVIDER=gemini
    // reaches Google and 404s. Defaults are picked per provider for that reason.
    // Defaults to gemini: it's the provider with a working key across
    // environments today, while anthropic support stays in place for whenever
    // a working Anthropic key is available again.
    const llmProvider = config.llmProvider ?? 'gemini';
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

    this.videos = {
      ltx: new LtxVideoAdapter({
        apiKey: config.ltxApiKey,
        model: config.ltxModel,
        ...(config.ltxBaseUrl ? { baseUrl: config.ltxBaseUrl } : {}),
      }),
      // Reuses the same GOOGLE_API_KEY/googleBaseUrl the image adapter
      // already reads — one Gemini API key, whichever of its models a
      // caller needs.
      google: new GeminiVideoAdapter({
        apiKey: config.googleApiKey,
        ...(config.googleBaseUrl ? { baseUrl: config.googleBaseUrl } : {}),
      }),
      stub: new StubVideoAdapter(),
    };

    this.engines = new Map<AnswerEngine, AnswerEngineClient>([
      ['claude', new ClaudeAnswerEngine({ apiKey: config.anthropicApiKey })],
      ['perplexity', new PerplexityAnswerEngine({ apiKey: config.perplexityApiKey })],
      ['chatgpt', new OpenAiAnswerEngine({ apiKey: config.openaiApiKey })],
      [
        'gemini',
        new GeminiAnswerEngine({ apiKey: config.googleApiKey, model: config.geminiEngineModel }),
      ],
    ]);

    this.searches = {
      tavily: new TavilySearchAdapter({ apiKey: config.tavilyApiKey }),
      serpapi: new SerpApiSearchAdapter({ apiKey: config.serpApiKey }),
      stub: new StubSearchAdapter(),
    };
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

  /** Video generation — the content pipeline's video counterpart to
   *  `imageGenerator()`. Pass a `provider` to bypass the configured default
   *  and pin a specific adapter — `generate-video.ts` does this to route
   *  `videoMode` to its own fixed provider, no fallback between them. */
  videoGenerator(provider?: VideoProviderName): VideoGenService {
    return this.videos[provider ?? this.config.videoProviderPrimary ?? 'ltx'];
  }

  answerEngine(engine: AnswerEngine): AnswerEngineClient | undefined {
    return this.engines.get(engine);
  }

  /** Real-time web search for a caller that wants exactly one provider. Most
   *  of the codebase does — content generation's brand-site importer, the AI
   *  research prompt box. See search.ts. */
  webSearch(): WebSearchService {
    return this.searches[this.config.searchProvider ?? 'tavily'];
  }

  /** Engines with credentials present — probes skip everything else. */
  configuredEngines(): AnswerEngineClient[] {
    return [...this.engines.values()].filter((client) => client.isConfigured());
  }

  /**
   * Every search provider with credentials present, `stub` excluded.
   *
   * The signal pipeline (trend-research.ts, intelligence-research.ts) is the
   * one caller that wants *all* of them rather than the single active one
   * `webSearch()` resolves to: a topic two independent providers both surface
   * is stronger evidence than either alone, which only exists to observe if
   * both are actually queried. Mirrors `configuredEngines()`'s reasoning for
   * GEO's answer-engine sweep — same shape, same "run against everything
   * configured, skip what isn't" behaviour.
   */
  configuredWebSearches(): WebSearchService[] {
    return Object.entries(this.searches)
      .filter(([name]) => name !== 'stub')
      .map(([, service]) => service)
      .filter((service) => service.isConfigured());
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
    tavilyApiKey: env.TAVILY_API_KEY,
    serpApiKey: env.SERPAPI_KEY,
    ltxApiKey: env.LTX_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { anthropicBaseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.GOOGLE_API_BASE_URL ? { googleBaseUrl: env.GOOGLE_API_BASE_URL } : {}),
    models: {
      ...(env.LLM_MODEL_ORCHESTRATOR ? { orchestrator: env.LLM_MODEL_ORCHESTRATOR } : {}),
      ...(env.LLM_MODEL_VOLUME ? { volume: env.LLM_MODEL_VOLUME } : {}),
      ...(env.LLM_MODEL_QA ? { qa: env.LLM_MODEL_QA } : {}),
    },
    geminiImageModel: env.IMAGE_MODEL_GEMINI,
    falEditModel: env.IMAGE_MODEL_FAL_EDIT,
    geminiEngineModel: env.GEO_MODEL_GEMINI,
    ...(env.IMAGE_STUB_LATENCY_MS ? { stubImageLatencyMs: Number(env.IMAGE_STUB_LATENCY_MS) } : {}),
    ltxModel: env.VIDEO_MODEL_LTX,
    ...(env.LTX_BASE_URL ? { ltxBaseUrl: env.LTX_BASE_URL } : {}),
    imageProviderPrimary: env.IMAGE_PROVIDER_PRIMARY as ImageProviderName | undefined,
    imageProviderEdit: env.IMAGE_PROVIDER_EDIT as ImageProviderName | undefined,
    videoProviderPrimary: env.VIDEO_PROVIDER_PRIMARY as VideoProviderName | undefined,
    llmProvider: env.LLM_PROVIDER as LlmProviderName | undefined,
    searchProvider: env.WEB_SEARCH_PROVIDER as SearchProviderName | undefined,
  });
}
