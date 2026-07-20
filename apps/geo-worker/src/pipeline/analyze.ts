import type { AiRegistry } from '@bmas/ai';
import type { Sentiment } from '@bmas/shared';

/**
 * Turns a raw engine answer into structured mentions.
 *
 * This is the measurement instrument, so it is deliberately conservative:
 * entities are only counted when named, `excerpt` must be verbatim from the
 * answer, and nothing is inferred from the model's own knowledge of the brand.
 * Changing this prompt changes the metric — treat edits as a methodology change
 * and re-run against stored `answer_text` before shipping.
 */

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    brandMentioned: { type: 'boolean' },
    summary: { type: 'string' },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string' },
          entityType: { type: 'string', enum: ['brand', 'competitor'] },
          position: { type: 'integer' },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          excerpt: { type: 'string' },
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
): Promise<{ analysis: AnalysisResult; costMicroUsd: number }> {
  const competitorList = input.competitors
    .map((c) => `- ${c.name}${c.aliases.length ? ` (also: ${c.aliases.join(', ')})` : ''}`)
    .join('\n');

  const system = [
    'You extract brand mentions from an AI assistant answer for a visibility-tracking product.',
    'Rules:',
    '1. Only report entities explicitly named in the answer text. Never infer from your own knowledge.',
    '2. `excerpt` must be copied verbatim from the answer.',
    '3. `position` is the 1-based order in which the entity first appears among all named businesses.',
    '4. `sentiment` describes how the answer characterises the entity, not your own opinion.',
    '5. `citedUrl` is a URL from the provided citation list only when the answer ties it to that entity; otherwise null.',
    '6. If neither the tracked brand nor any competitor appears, return an empty mentions array.',
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
    parse: (raw) => raw as AnalysisResult,
  });

  return { analysis: result.value, costMicroUsd: result.cost.costMicroUsd };
}

export interface AnalysisResult {
  brandMentioned: boolean;
  summary: string;
  mentions: RawMention[];
}
