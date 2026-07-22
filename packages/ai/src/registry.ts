import type { AnswerEngine } from '@bmas/shared';
import { AnthropicLlmAdapter } from './adapters/anthropic.llm.js';
import { ClaudeAnswerEngine } from './adapters/claude.engine.js';
import { FalImageAdapter } from './adapters/fal.image.js';
import { GeminiAnswerEngine } from './adapters/gemini.engine.js';
import { GeminiImageAdapter } from './adapters/gemini.image.js';
import { GeminiLlmAdapter } from './adapters/gemini.llm.js';
import { OpenAiAnswerEngine } from './adapters/openai.engine.js';
import { PerplexityAnswerEngine } from './adapters/perplexity.engine.js';
import type { AnswerEngineClient } from './engine.js';
import type { ImageGenService } from './image.js';
import type { LlmService, ModelRole } from './llm.js';

export interface AiConfig {
  anthropicApiKey?: string;
  googleApiKey?: string;
  falApiKey?: string;
  openaiApiKey?: string;
  perplexityApiKey?: string;

  models?: Partial<Record<ModelRole, string>>;
  /**
   * Which provider backs `llm()`. Defaults to Anthropic; `gemini` is a stopgap
   * so GEO's analyser can run on a Google key before an Anthropic key exists.
   */
  llmProvider?: 'anthropic' | 'gemini';
  /** Model the Gemini LLM backend uses when llmProvider is 'gemini'. */
  geminiLlmModel?: string;
  /** Model the Gemini GEO probe asks; distinct from the image model. */
  geminiEngineModel?: string;
  geminiImageModel?: string;
  falEditModel?: string;

  /** Which adapter serves each image operation. */
  imageProviderPrimary?: 'gemini' | 'fal';
  imageProviderEdit?: 'gemini' | 'fal';
}

const DEFAULT_MODELS: Record<ModelRole, string> = {
  // Reasoning-heavy orchestration: brief composition, GEO answer analysis.
  orchestrator: 'claude-opus-4-8',
  // High fan-out, latency-sensitive: per-platform copy variants.
  volume: 'claude-haiku-4-5',
  // Judgement calls: vision QA readback on rendered creatives.
  qa: 'claude-sonnet-5',
};

/**
 * Single place that decides which adapter serves which operation. Swapping a
 * provider is a config change here, never an edit in product code.
 */
export class AiRegistry {
  private readonly llmService: LlmService;
  private readonly images: Record<'gemini' | 'fal', ImageGenService>;
  private readonly engines: Map<AnswerEngine, AnswerEngineClient>;

  constructor(private readonly config: AiConfig) {
    // Anthropic by default; Gemini only when explicitly selected. The content
    // workstream's ai.llm() usage rides on the default and is unaffected.
    this.llmService =
      config.llmProvider === 'gemini'
        ? new GeminiLlmAdapter({ apiKey: config.googleApiKey, model: config.geminiLlmModel })
        : new AnthropicLlmAdapter({
            apiKey: config.anthropicApiKey,
            models: { ...DEFAULT_MODELS, ...config.models },
          });

    this.images = {
      gemini: new GeminiImageAdapter({
        apiKey: config.googleApiKey,
        model: config.geminiImageModel,
      }),
      fal: new FalImageAdapter({ apiKey: config.falApiKey, editModel: config.falEditModel }),
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
    models: {
      ...(env.LLM_MODEL_ORCHESTRATOR ? { orchestrator: env.LLM_MODEL_ORCHESTRATOR } : {}),
      ...(env.LLM_MODEL_VOLUME ? { volume: env.LLM_MODEL_VOLUME } : {}),
      ...(env.LLM_MODEL_QA ? { qa: env.LLM_MODEL_QA } : {}),
    },
    llmProvider: env.LLM_PROVIDER === 'gemini' ? 'gemini' : undefined,
    geminiLlmModel: env.LLM_MODEL_GEMINI,
    geminiEngineModel: env.GEO_MODEL_GEMINI,
    geminiImageModel: env.IMAGE_MODEL_GEMINI,
    falEditModel: env.IMAGE_MODEL_FAL_EDIT,
    imageProviderPrimary: env.IMAGE_PROVIDER_PRIMARY as 'gemini' | 'fal' | undefined,
    imageProviderEdit: env.IMAGE_PROVIDER_EDIT as 'gemini' | 'fal' | undefined,
  });
}
