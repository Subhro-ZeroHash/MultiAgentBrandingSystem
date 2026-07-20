import { z } from 'zod';

/**
 * The generative engines whose answers we measure. Each maps to an adapter in
 * `@bmas/ai` implementing `AnswerEngineClient`.
 */
export const answerEngineSchema = z.enum([
  'chatgpt',
  'perplexity',
  'gemini',
  'claude',
  'copilot',
  'ai_overviews',
]);
export type AnswerEngine = z.infer<typeof answerEngineSchema>;

export const engineCapabilitiesSchema = z.object({
  engine: answerEngineSchema,
  /** Whether the engine returns source URLs we can attribute mentions to. */
  returnsCitations: z.boolean(),
  /** Whether the engine performs live retrieval vs answering from weights. */
  livesearch: z.boolean(),
  /** Whether we can pin a geography for the query. */
  supportsLocale: z.boolean(),
});
export type EngineCapabilities = z.infer<typeof engineCapabilitiesSchema>;

export const ENGINE_CAPABILITIES: Record<AnswerEngine, EngineCapabilities> = {
  chatgpt: { engine: 'chatgpt', returnsCitations: true, livesearch: true, supportsLocale: false },
  perplexity: {
    engine: 'perplexity',
    returnsCitations: true,
    livesearch: true,
    supportsLocale: true,
  },
  gemini: { engine: 'gemini', returnsCitations: true, livesearch: true, supportsLocale: true },
  claude: { engine: 'claude', returnsCitations: true, livesearch: true, supportsLocale: false },
  copilot: { engine: 'copilot', returnsCitations: true, livesearch: true, supportsLocale: false },
  ai_overviews: {
    engine: 'ai_overviews',
    returnsCitations: true,
    livesearch: true,
    supportsLocale: true,
  },
};
