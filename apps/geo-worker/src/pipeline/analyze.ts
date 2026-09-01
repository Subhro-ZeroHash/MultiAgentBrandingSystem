import type { AiRegistry } from '@bmas/ai';
import type { CostEvent, Sentiment } from '@bmas/shared';

/**
 * Turns a raw engine answer into structured mentions.
 *
 * This is the measurement instrument, so it is deliberately conservative:
 * entities are only counted when named, `excerpt` must be verbatim from the
 * answer, and nothing is inferred from the model's own knowledge of the brand.
 * Changing this prompt changes the metric — treat edits as a methodology change
 * and re-run against stored `answer_text` before shipping.
 */

/** See the `maxTokens` comment at the call site — an answer naming several
 *  brands needs more than the adapter's default to serialise. */
const MAX_ANALYSIS_TOKENS = 8_000;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    brandMentioned: { type: 'boolean' },
    summary: {
      type: 'string',
      description: 'What the answer said about this space, in 2-3 sentences. Under 400 characters.',
    },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string' },
          entityType: { type: 'string', enum: ['brand', 'competitor'] },
          position: { type: 'integer' },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          excerpt: {
            type: 'string',
            description: 'The shortest quote showing how this entity was described. Under 200 characters.',
          },
          citedUrl: { type: ['string', 'null'] },
        },
        required: ['entityName', 'entityType', 'position', 'sentiment', 'excerpt', 'citedUrl'],
        additionalProperties: false,
      },
    },
  },
  required: ['brandMentioned', 'summary', 'mentions'],
  additionalProperties: false,
} as const;

export interface AnalyzeInput {
  answerText: string;
  citations: Array<{ url: string; title: string | null; rank: number }>;
  brandName: string;
  brandAliases: string[];
  competitors: Array<{ id: string; name: string; aliases: string[] }>;
}

interface RawMention {
  entityName: string;
  entityType: 'brand' | 'competitor';
  position: number;
  sentiment: Sentiment;
  excerpt: string;
  citedUrl: string | null;
}

export async function analyzeAnswer(
  ai: AiRegistry,
  input: AnalyzeInput,
): Promise<{ analysis: AnalysisResult; cost: CostEvent }> {
  const competitorList = input.competitors
    .map((c) => `- ${c.name}${c.aliases.length ? ` (also: ${c.aliases.join(', ')})` : ''}`)
    .join('\n');

  const system = [
    'You extract business mentions from an AI assistant answer for a brand-visibility product.',
    'You are given ONE tracked brand and a list of known competitors.',
    'Rules:',
    '1. Report every distinct business named in the answer (a brand, shop, restaurant, or retailer), in the order it appears. Reporting the whole field is what makes share-of-voice meaningful — do not report only the tracked brand.',
    '2. entityType is "brand" ONLY for the tracked brand named below, including clear variants of its name (an abbreviation, or the name with or without a suffix such as "Silks" or "(A2B)"). EVERY other business is "competitor", including businesses that are not in the known-competitor list.',
    '3. Never label a business as "brand" unless it is the tracked brand. Do NOT report products, dishes, ingredients, cities, or generic categories — only named businesses.',
    '4. Never infer from your own knowledge; report only what the answer text names.',
    '5. `excerpt` must be copied verbatim from the answer.',
    '6. `position` is the 1-based order in which the business first appears among all named businesses.',
    '7. `sentiment` describes how the answer characterises the business, not your own opinion.',
    '8. `citedUrl` is a URL from the provided citation list only when the answer ties it to that business; otherwise null.',
    '9. If no businesses are named at all, return an empty mentions array.',
  ].join('\n');

  const prompt = [
    `Tracked brand: ${input.brandName}`,
    input.brandAliases.length ? `Brand aliases: ${input.brandAliases.join(', ')}` : '',
    competitorList ? `Known competitors:\n${competitorList}` : 'Known competitors: none provided',
    '',
    'Citations offered by the engine:',
    input.citations.length
      ? input.citations.map((c) => `[${c.rank}] ${c.url}`).join('\n')
      : '(none)',
    '',
    'Answer to analyse:',
    '---',
    input.answerText,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await ai.llm().generateJson<AnalysisResult>({
    role: 'orchestrator',
    effort: 'medium',
    system,
    schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    messages: [{ role: 'user', content: prompt }],
    // Left unset this fell back to the adapter's 4096 default, which an
    // answer naming several brands overruns: the response is cut mid-string
    // and fails to parse as JSON. The retry is worthless in that case, since
    // the same prompt gets the same budget and truncates again — which is why
    // probes were failing repeatedly rather than recovering. Bounding the
    // fields above does most of the work; this is the headroom for an answer
    // that legitimately names a lot of competitors.
    maxTokens: MAX_ANALYSIS_TOKENS,
    parse: (raw) => raw as AnalysisResult,
  });

  return { analysis: result.value, cost: result.cost };
}

export interface AnalysisResult {
  brandMentioned: boolean;
  summary: string;
  mentions: RawMention[];
}
