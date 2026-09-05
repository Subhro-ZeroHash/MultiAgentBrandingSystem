import { withRetry, withTimeout, type AiRegistry } from '@bmas/ai';
import { brandCompetitorSchema, type BrandCompetitor, type CostEvent } from '@bmas/shared';
import { z } from 'zod';

/**
 * "Who am I up against?" — one web search plus one extraction pass, surfaced
 * as a proposal (FR-adjacent to the website importer's own "read it, then let
 * the user decide" shape). Nothing here is persisted; `BrandContextService`
 * never sees these until the user adds one to their list and saves.
 */

const MAX_SEARCH_RESULTS = 8;
const MAX_SUGGESTIONS = 6;
const SEARCH_TIMEOUT_MS = 20_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
/**
 * 1024 was too tight in practice: constrained decoding cut short by the token
 * ceiling produces valid-looking JSON that fails to parse (an unterminated
 * string), so every attempt failed the same way rather than some — the
 * symptom pointed at this number, not at the model. Six competitors' worth of
 * name + URL + a full-sentence note needs real headroom (see
 * MAX_ANALYSIS_TOKENS in analyze-site.ts for the same reasoning at a larger
 * scale).
 */
const MAX_EXTRACTION_TOKENS = 3072;

const SUGGESTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['competitors'],
  properties: {
    competitors: {
      type: 'array',
      maxItems: MAX_SUGGESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'websiteUrl', 'note'],
        properties: {
          name: {
            type: 'string',
            description: 'The competing business, not a directory or marketplace.',
          },
          websiteUrl: { type: ['string', 'null'] },
          note: {
            type: 'string',
            description:
              'One line on why they compete for the same customer — "cheaper, same audience", ' +
              '"the name every customer already knows". Never a generic description of the industry.',
          },
        },
      },
    },
  },
} as const;

const discoveryResultSchema = z.object({
  competitors: z.array(brandCompetitorSchema),
});

/** Both cases below are the caller's to fix (add an industry, configure a
 *  search provider) rather than a provider hiccup — callers should surface
 *  these as a 400, not the transient-failure 500 an unrecognised throw gets. */
export class CompetitorDiscoveryInputError extends Error {}

export interface DiscoverCompetitorsInput {
  brandName: string;
  industry: string | null;
  location: string | null;
  audience: string | null;
  /** Names already on the brand's list, so the model doesn't waste a slot
   *  re-suggesting one the user already has. */
  known: string[];
}

export interface DiscoverCompetitorsResult {
  suggestions: BrandCompetitor[];
  costs: CostEvent[];
}

export async function discoverCompetitors(
  ai: AiRegistry,
  input: DiscoverCompetitorsInput,
  ctx?: { brandId?: string; referenceId?: string },
): Promise<DiscoverCompetitorsResult> {
  const search = ai.webSearch();
  if (!search.isConfigured()) {
    throw new CompetitorDiscoveryInputError(
      'No web search provider is configured, so competitors cannot be found automatically.',
    );
  }

  // Needs at least a business type to search for — "X competitors" with no X
  // is too generic to return anything usable, and worse, likely to return
  // completely unrelated businesses that just happen to rank for the word
  // "competitors".
  if (!input.industry) {
    throw new CompetitorDiscoveryInputError(
      'Add an industry first — competitor search needs to know what kind of business this is.',
    );
  }

  const query = [input.industry, 'competitors', input.location].filter(Boolean).join(' ');
  const { value: results, cost: searchCost } = await withTimeout(
    search.search({ query, maxResults: MAX_SEARCH_RESULTS }, ctx),
    SEARCH_TIMEOUT_MS,
    `competitor discovery search (${search.provider})`,
  );

  if (results.length === 0) {
    return { suggestions: [], costs: [searchCost] };
  }

  const knownLower = new Set(input.known.map((name) => name.toLowerCase()));

  const { value, cost: extractionCost } = await withRetry(
    () =>
      withTimeout(
        ai.llm().generateJson<{ competitors: BrandCompetitor[] }>(
          {
            role: 'volume',
            system:
              'You read web search results and identify real competing businesses — never ' +
              'directories, marketplaces, news aggregators, or the brand itself. If a result is not ' +
              'clearly a specific competing business, leave it out rather than guessing.',
            messages: [
              {
                role: 'user',
                content: [
                  `Brand: ${input.brandName}`,
                  `Industry: ${input.industry}`,
                  input.location ? `Location: ${input.location}` : '',
                  input.audience ? `Audience: ${input.audience}` : '',
                  input.known.length
                    ? `Already known, do not repeat: ${input.known.join(', ')}`
                    : '',
                  '',
                  'Search results:',
                  ...results.map(
                    (result, index) =>
                      `${index + 1}. ${result.title ?? result.url} — ${result.url}\n${result.snippet}`,
                  ),
                  '',
                  `List up to ${MAX_SUGGESTIONS} real competing businesses these results point to.`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_EXTRACTION_TOKENS,
            schema: SUGGESTIONS_JSON_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => discoveryResultSchema.parse(raw),
          },
          ctx,
        ),
        EXTRACTION_TIMEOUT_MS,
        'competitor discovery extraction',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[brands] competitor discovery attempt ${attempt} failed, retrying:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );

  const suggestions = value.competitors.filter(
    (competitor) => !knownLower.has(competitor.name.toLowerCase()),
  );

  return { suggestions, costs: [searchCost, extractionCost] };
}
