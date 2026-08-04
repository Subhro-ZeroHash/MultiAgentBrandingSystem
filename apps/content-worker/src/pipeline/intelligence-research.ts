import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult } from '@bmas/ai';
import {
  eq,
  getTrendContext,
  recordContextSnapshot,
  renderBrandContextLines,
  schema,
  sql,
  type Brand,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeIntelligenceScore,
  intelligenceSynthesisSchema,
  type CostEvent,
  type IntelligenceCategory,
  type IntelligenceItemDraft,
  type IntelligenceResearchJob,
  type TrendSource,
} from '@bmas/shared';
import type { WorkerContext } from '../context.js';

/**
 * Leads / Business Intelligence Agent.
 *
 * The counterpart to Trend Research (trend-research.ts), sharing its whole
 * shape deliberately: real search first, one judgment call on top. What
 * differs is the question asked of the results. Trend research asks "can this
 * become a piece of content?"; this asks "should the brand owner know about
 * this?" — government policy, competitor moves, industry shifts, local
 * developments. Neither agent can answer the other's question well, which is
 * why they stay two pipelines rather than one with a mode flag: the search
 * queries are different, the scoring axes are different (business impact vs.
 * marketing potential), and mixing the outputs into one feed would bury a
 * regulatory change under festival post ideas.
 */

const SEARCH_TIMEOUT_MS = 15_000;
// Five categories of real search results is a larger prompt than trend
// research's three; sized with the same headroom logic as
// SYNTHESIS_TIMEOUT_MS there.
const SYNTHESIS_TIMEOUT_MS = 90_000;
const MAX_SYNTHESIS_TOKENS = 14_000;
const RESULTS_PER_QUERY = 6;
const MAX_SNIPPET_CHARS = 500;

interface CollectedSignal {
  category: IntelligenceCategory;
  request: WebSearchRequest;
  results: WebSearchResult[];
}

/**
 * The five searches an intelligence run fans out. Pure and exported for the
 * same reason `buildTrendSearchQueries` is: testable query construction
 * without a network call.
 *
 * Every query is built from the Context Manager's reading of the brand, not
 * generic terms — "latest trends" would return nothing usably specific;
 * "latest sportswear trends India" or "government policies footwear India"
 * does. That's the whole point of running this per-brand instead of once
 * globally.
 */
export function buildIntelligenceSearchQueries(input: {
  industry: string | null;
  location: string | null;
  competitors: string[];
}): Array<{ category: IntelligenceCategory; request: WebSearchRequest }> {
  const industry = input.industry?.trim() || 'small business';
  const location = input.location?.trim() || null;
  const locality = location ? ` in ${location}` : ' in India';
  const competitorNames = input.competitors.slice(0, 3);

  const queries: Array<{ category: IntelligenceCategory; request: WebSearchRequest }> = [
    {
      category: 'government_policy',
      request: {
        query: `new government policy regulation tax changes affecting ${industry} businesses${locality}`,
        topic: 'news',
        recencyDays: 30,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'industry_news',
      request: {
        query: `${industry} industry news market developments trends this month${locality}`,
        topic: 'news',
        recencyDays: 21,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'local',
      request: {
        query: `local business news economic developments opportunities${locality}`,
        topic: 'news',
        recencyDays: 21,
        maxResults: RESULTS_PER_QUERY,
      },
    },
  ];

  // Only searched when the brand has actually named competitors — an empty
  // "competitor news" query against no names returns generic noise, worse
  // than not asking at all.
  if (competitorNames.length > 0) {
    queries.push({
      category: 'competitor',
      request: {
        query: `recent news announcements launches: ${competitorNames.join(', ')}`,
        topic: 'news',
        recencyDays: 30,
        maxResults: RESULTS_PER_QUERY,
      },
    });
  }

  return queries;
}

async function recordCost(
  ctx: WorkerContext,
  brandId: string,
  runId: string,
  cost: CostEvent,
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: runId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

/** Same "one category failing doesn't sink the run, all of them failing does"
 *  logic as collectTrendSignals — see that function's comment. */
async function collectIntelligenceSignals(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  queries: Array<{ category: IntelligenceCategory; request: WebSearchRequest }>,
): Promise<CollectedSignal[]> {
  const collected: CollectedSignal[] = [];

  for (const { category, request } of queries) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          ctx.ai.webSearch().search(request, { brandId: brand.id, referenceId: runId }),
          SEARCH_TIMEOUT_MS,
          `intelligence search (${category})`,
        ),
      );
      await recordCost(ctx, brand.id, runId, cost);
      collected.push({ category, request, results });
    } catch (error) {
      console.warn(
        `[intelligence-research] ${category} search failed for run ${runId}: ${describeError(error)}`,
      );
    }
  }

  if (collected.every((signal) => signal.results.length === 0)) {
    throw new Error(
      'No search results were available to research intelligence from — every search failed or returned nothing.',
    );
  }

  return collected;
}

const CATEGORY_LABEL: Record<IntelligenceCategory, string> = {
  government_policy: 'GOVERNMENT & POLICY',
  industry_news: 'INDUSTRY NEWS',
  local: 'LOCAL DEVELOPMENTS',
  competitor: 'COMPETITOR NEWS',
  brand_news: 'BRAND NEWS',
};

function describeSignalsForPrompt(signals: CollectedSignal[]): string {
  return signals
    .map(({ category, results }) => {
      if (results.length === 0) return `## ${CATEGORY_LABEL[category]}\n(search returned nothing)`;

      const rows = results
        .map((result, i) => {
          const date = result.publishedAt ? ` (${result.publishedAt})` : '';
          const snippet = result.snippet.slice(0, MAX_SNIPPET_CHARS);
          return `${i + 1}. [${result.title ?? 'Untitled'}]${date} — ${result.url}\n   ${snippet}`;
        })
        .join('\n');

      return `## ${CATEGORY_LABEL[category]}\n${rows}`;
    })
    .join('\n\n');
}

/** Clips array lengths before zod validation — same reasoning as
 *  clipSynthesisCounts in trend-research.ts: an "up to 10" instruction
 *  overshooting by one or two is a cosmetic overage, not a malformed
 *  response, and should be trimmed rather than thrown on. */
export function clipIntelligenceCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) return raw;
  const items = (raw as { items: unknown }).items;
  if (!Array.isArray(items)) return raw;

  return {
    ...raw,
    items: items.slice(0, 10).map((item) => {
      if (typeof item !== 'object' || item === null || !('sources' in item)) return item;
      const sources = (item as { sources: unknown }).sources;
      return Array.isArray(sources) ? { ...item, sources: sources.slice(0, 5) } : item;
    }),
  };
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'title', 'summary', 'whyItMatters', 'urgency', 'score', 'sources'],
        properties: {
          category: {
            enum: ['government_policy', 'brand_news', 'industry_news', 'competitor', 'local'],
          },
          title: { type: 'string', description: 'Short, specific — names what actually happened.' },
          summary: {
            type: 'string',
            description: 'What actually happened, grounded in the search results above. 2-4 sentences.',
          },
          whyItMatters: {
            type: 'string',
            description:
              'The answer to "so what?" for THIS brand specifically — not the industry in general. ' +
              'Name the concrete effect: a cost, a risk, an opportunity, a decision to make.',
          },
          urgency: { enum: ['low', 'medium', 'high'] },
          score: {
            type: 'object',
            additionalProperties: false,
            required: [
              'brandRelevance',
              'industryRelevance',
              'geographicRelevance',
              'recency',
              'businessImpact',
            ],
            properties: {
              brandRelevance: {
                type: 'number',
                description: '0-100. How directly this affects this brand\'s business, not its content.',
              },
              industryRelevance: {
                type: 'number',
                description: '0-100. How much this matters to this brand\'s specific industry.',
              },
              geographicRelevance: {
                type: 'number',
                description: '0-100. How much this matters given where the brand trades.',
              },
              recency: { type: 'number', description: '0-100. How current/time-sensitive it is.' },
              businessImpact: {
                type: 'number',
                description: '0-100. How consequential this is if the brand does nothing about it.',
              },
            },
          },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['url', 'title'],
              properties: { url: { type: 'string' }, title: { type: ['string', 'null'] } },
            },
            description: 'Only URLs that actually appear in the search results above. Never invent one.',
          },
        },
      },
    },
  },
} as const;

/** Same schema-rejection retry as trend-research.ts's synthesizeTrendIdeas —
 *  see that function's comment for the full reasoning. Kept as a narrow,
 *  message-matched retry rather than a general one. */
const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

async function synthesizeIntelligenceItems(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signals: CollectedSignal[],
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizeIntelligenceItemsOnce(ctx, runId, brand, brandContext, signals);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[intelligence-research] synthesis rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function synthesizeIntelligenceItemsOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signals: CollectedSignal[],
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: IntelligenceItemDraft[] }>(
          {
            role: 'orchestrator',
            system:
              'You are a business intelligence analyst keeping one small business owner informed. ' +
              'You work ONLY from the search results you are given — never invent a policy, a news ' +
              'item, a fact, or a date that is not actually present in the results.\n\n' +
              'This is NOT a content-ideas feed. Do not suggest marketing angles or campaigns. The ' +
              'question for every item is: does the brand owner need to know this to run their ' +
              'business well — a cost, a risk, a regulatory obligation, a competitive threat, an ' +
              'opportunity? If a search result is only interesting as a marketing trend and carries no ' +
              'business-decision weight, leave it out — that is what the separate trend agent is for.\n\n' +
              'If nothing in a category is genuinely relevant to this brand, return fewer items — or ' +
              'none from that category — rather than manufacturing a weak one to fill a quota.',
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  '',
                  '**Live search results, grouped by what was searched for:**',
                  describeSignalsForPrompt(signals),
                  '',
                  'Produce up to 10 ranked items. `whyItMatters` must name the concrete effect on THIS ' +
                    'brand, not restate the industry-wide news. Score honestly — a huge industry story ' +
                    'that does not actually touch this brand should score low on brandRelevance even if ' +
                    'recency and industryRelevance are high.',
                  'Every `sources` entry must be a URL that literally appears above, and there must be ' +
                    'no more than 5 per item. Do not cite anything else, and do not paraphrase a URL ' +
                    'from memory.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_SYNTHESIS_TOKENS,
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => intelligenceSynthesisSchema.parse(clipIntelligenceCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        SYNTHESIS_TIMEOUT_MS,
        'intelligence synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[intelligence-research] synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { items: value.items, cost };
}

/** Same fabrication guard as trend-research.ts's verifySources. */
export function verifyIntelligenceSources(
  sources: TrendSource[],
  signals: CollectedSignal[],
): TrendSource[] {
  const known = new Set(signals.flatMap((signal) => signal.results.map((r) => r.url)));
  return sources.filter((source) => known.has(source.url));
}

export async function runIntelligenceResearch(
  ctx: WorkerContext,
  job: IntelligenceResearchJob,
): Promise<void> {
  const [run] = await ctx.db
    .select()
    .from(schema.intelligenceRuns)
    .where(eq(schema.intelligenceRuns.id, job.runId))
    .limit(1);
  if (!run) throw new Error(`Intelligence research run ${job.runId} not found`);

  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  await ctx.db
    .update(schema.intelligenceRuns)
    .set({ status: 'running', startedAt: sql`coalesce(${schema.intelligenceRuns.startedAt}, now())` })
    .where(eq(schema.intelligenceRuns.id, run.id));

  try {
    const brandContext = await getTrendContext(ctx.db, brand.id);

    const queries = buildIntelligenceSearchQueries({
      industry: brandContext.identity.industry ?? brand.category,
      location: brandContext.identity.location ?? brand.location,
      competitors: brandContext.competitors.map((c) => c.name),
    });

    await recordContextSnapshot(ctx.db, {
      brandId: brand.id,
      agentType: 'intelligence',
      snapshot: { ...brandContext, queries: queries.map((query) => query.request.query) },
    });

    const signals = await collectIntelligenceSignals(ctx, run.id, brand, queries);

    const { items, cost } = await synthesizeIntelligenceItems(ctx, run.id, brand, brandContext, signals);
    await recordCost(ctx, brand.id, run.id, cost);

    const rows = items.map((item) => ({
      runId: run.id,
      category: item.category,
      title: item.title,
      summary: item.summary,
      whyItMatters: item.whyItMatters,
      urgency: item.urgency,
      score: { ...item.score, overall: computeIntelligenceScore(item.score) },
      sources: verifyIntelligenceSources(item.sources, signals),
    }));

    // Replace rather than append — same BullMQ-redelivery reasoning as
    // runTrendResearch: a retried run must not duplicate items from the
    // partial attempt before it.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.intelligenceItems).where(eq(schema.intelligenceItems.runId, run.id));
      if (rows.length) await tx.insert(schema.intelligenceItems).values(rows);
      await tx
        .update(schema.intelligenceRuns)
        .set({ status: 'succeeded', finishedAt: new Date(), error: null })
        .where(eq(schema.intelligenceRuns.id, run.id));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[intelligence-research] run ${run.id} failed: ${message}`);
    await ctx.db
      .update(schema.intelligenceRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.intelligenceRuns.id, run.id));
    throw error;
  }
}
