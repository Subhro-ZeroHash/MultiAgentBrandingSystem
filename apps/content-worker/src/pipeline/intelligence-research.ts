import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '@bmas/ai';
import {
  eq,
  getTrendContext,
  recordContextSnapshot,
  renderBrandContextLines,
  schema,
  sql,
  type Brand,
  type PoolIntelligenceItemRow,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeIntelligenceScore,
  intelligenceItemDraftSchema,
  intelligenceRelevanceSynthesisSchema,
  type CostEvent,
  type IntelligenceCategory,
  type IntelligenceItemDraft,
  type IntelligenceModelScore,
  type IntelligenceRelevanceDraft,
  type IntelligenceResearchJob,
  type TrendSource,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { dateGrounding } from './prompt-context.js';
import { notifyBrandOwner } from './push.js';
import { ensureBrandCategoryKey } from './category-classifier.js';
import { ensureBrandMarket } from './market-classifier.js';
import { ensureFreshIntelligencePool } from './pool-loader.js';

/**
 * Leads / Business Intelligence Agent — Layer B (brand relevance).
 *
 * Same redesign as trend-research.ts, for the same reason: `government_
 * policy`, `industry_news` and `local` are not actually brand-specific —
 * only their relevance is — so those three now come from the shared pool
 * (see intelligence-pool-refresh.ts) instead of a fresh per-brand search.
 * `competitor` is the one category that genuinely cannot be pooled (named
 * competitors differ per brand) and stays as a small, live, per-brand
 * search here — now roughly a quarter the size of the old prompt, since it
 * is the only category this file still searches for.
 *
 * `intelligence_runs` / `intelligence_items`, the job schema, the queue, the
 * controller and the frontend all stay exactly as they were.
 */

const SEARCH_TIMEOUT_MS = 15_000;
// See trend-research.ts's own RELEVANCE_TIMEOUT_MS comment: confirmed live
// that a smaller prompt does not mean proportionally faster local inference,
// so this matches the same 300s headroom rather than the tighter ceiling a
// smaller prompt might suggest.
const RELEVANCE_TIMEOUT_MS = 300_000;
const MAX_RELEVANCE_TOKENS = 4_000;
// Roughly a quarter of the old MAX_SYNTHESIS_TOKENS (14_000) — competitor
// news is the only category still searched here, one query instead of four.
const COMPETITOR_SYNTHESIS_TIMEOUT_MS = 300_000;
const MAX_COMPETITOR_SYNTHESIS_TOKENS = 6_000;
const RESULTS_PER_QUERY = 6;
/**
 * Floor for a brand-specific item's own `brandRelevance` score.
 *
 * Pooled items are filtered by a dedicated relevance pass; brand-specific
 * ones are not, so without this the only gate is the search engine. Set at
 * the point where the model is saying "this is about the right industry but
 * not really about this business" — high enough to drop an unrelated banking
 * acquisition that a footwear industry query happened to surface, low enough
 * to keep a genuine sector development the brand does not appear in.
 */
const MIN_BRAND_RELEVANCE = 35;
const MAX_SNIPPET_CHARS = 500;

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

// ---------------------------------------------------------------------------
// Pool relevance scoring — government_policy / industry_news / local
// ---------------------------------------------------------------------------

function describePoolItemsForPrompt(poolItems: PoolIntelligenceItemRow[]): string {
  return poolItems
    .map(
      (item, index) =>
        `[${index}] (${item.category}) ${item.title}\n` +
        `   ${item.summary}\n` +
        `   Urgency: ${item.urgency}, Business impact: ${item.score.businessImpact}, ` +
        `Recency: ${item.score.recency}`,
    )
    .join('\n\n');
}

/** Same "clip rather than reject an overshoot" reasoning as
 *  trend-research.ts's `clipRelevanceCounts`. */
export function clipIntelligenceRelevanceCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) return raw;
  const items = (raw as { items: unknown }).items;
  if (!Array.isArray(items)) return raw;

  return { ...raw, items: items.slice(0, 10) };
}

const RELEVANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'poolItemIndex',
          'brandRelevance',
          'industryRelevance',
          'geographicRelevance',
          'whyItMatters',
        ],
        properties: {
          poolItemIndex: {
            type: 'integer',
            description: 'The [N] number of the development this score is for.',
          },
          brandRelevance: {
            type: 'number',
            description: "0-100. How directly this affects this brand's business, not its content.",
          },
          industryRelevance: {
            type: 'number',
            description: "0-100. How much this matters to this brand's specific industry.",
          },
          geographicRelevance: {
            type: 'number',
            description: '0-100. How much this matters given where the brand trades.',
          },
          whyItMatters: {
            type: 'string',
            description:
              'The answer to "so what?" for THIS brand specifically — not the industry in general. ' +
              'Name the concrete effect: a cost, a risk, an opportunity, a decision to make.',
          },
        },
      },
    },
  },
} as const;

const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

async function scoreIntelligenceRelevance(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  market: string,
  poolItems: PoolIntelligenceItemRow[],
): Promise<{ items: IntelligenceRelevanceDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await scoreIntelligenceRelevanceOnce(
        ctx,
        runId,
        brand,
        brandContext,
        market,
        poolItems,
      );
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[intelligence-research] relevance scoring rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function scoreIntelligenceRelevanceOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  market: string,
  poolItems: PoolIntelligenceItemRow[],
): Promise<{ items: IntelligenceRelevanceDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: IntelligenceRelevanceDraft[] }>(
          {
            role: 'orchestrator',
            system:
              dateGrounding(market) +
              'You are a business intelligence analyst judging how relevant a set of ' +
              'already-identified developments are for ONE SPECIFIC small business. The ' +
              'developments below were identified generically for the whole category/country, not ' +
              'for this brand — your job is to judge how much each one actually affects this ' +
              'business, and to say why.\n\n' +
              'This is NOT a content-ideas feed — judge business consequence, not marketing angle. ' +
              'Score honestly: a huge industry story that does not actually touch this brand should ' +
              'score low on brandRelevance even if it is significant industry-wide. Omit anything ' +
              'genuinely irrelevant rather than including it with a low score to fill a quota.',
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  '',
                  '**Developments to judge, numbered — reference the [N] number in `poolItemIndex`:**',
                  describePoolItemsForPrompt(poolItems),
                  '',
                  'Return up to 10, ranked by how much they matter to this brand.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_RELEVANCE_TOKENS,
            schema: RELEVANCE_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) =>
              intelligenceRelevanceSynthesisSchema.parse(clipIntelligenceRelevanceCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        RELEVANCE_TIMEOUT_MS,
        'intelligence relevance scoring',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[intelligence-research] relevance scoring attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { items: value.items, cost };
}

/** Same index-resolution posture as trend-research.ts's
 *  `resolveRelevanceDrafts`. */
export function resolveIntelligenceRelevanceDrafts(
  drafts: IntelligenceRelevanceDraft[],
  poolItems: PoolIntelligenceItemRow[],
): Array<{ poolItem: PoolIntelligenceItemRow; draft: IntelligenceRelevanceDraft }> {
  const seen = new Set<number>();
  return drafts
    .filter((draft) => {
      const index = draft.poolItemIndex;
      if (index < 0 || index >= poolItems.length || seen.has(index)) return false;
      seen.add(index);
      return true;
    })
    .map((draft) => ({ poolItem: poolItems[draft.poolItemIndex]!, draft }));
}

// ---------------------------------------------------------------------------
// Competitor search — the one category that cannot be pooled
// ---------------------------------------------------------------------------

interface CollectedSignal {
  /** Which search provider produced these results. */
  provider: string;
  results: WebSearchResult[];
}

/**
 * The per-brand half of the intelligence feed.
 *
 * The pool covers `government_policy`, `industry_news` and `local`, but it is
 * bucketed by a fixed taxonomy — a footwear brand lands in `fashion_apparel`,
 * so every pooled query asks about "Fashion & Apparel" and the brand's real
 * niche never reaches a search engine. That is the right trade for the shared
 * layer (one search serves every fashion brand) and the wrong one for the two
 * categories that are inherently about *this* business.
 *
 * So these queries use the brand's own words — its actual industry text and
 * name — and cover the three categories the pool cannot:
 *
 *  - `brand_news`: previously unreachable. It was excluded from the poolable
 *    set and never searched per-brand, so the category could not produce an
 *    item under any circumstances.
 *  - `competitor`: previously skipped entirely whenever a brand had named no
 *    competitors, which is the default state. Falls back to discovering them
 *    from the industry and market rather than going silent.
 *  - a niche `industry_news` query, which is what makes the feed read as
 *    footwear rather than apparel.
 */
export function buildBrandIntelligenceQueries(identity: {
  brandName: string;
  industry: string | null;
  location: string | null;
  competitors: string[];
}): Array<{ category: IntelligenceCategory; request: WebSearchRequest }> {
  const { brandName, competitors } = identity;
  const industry = identity.industry?.trim() || null;
  const place = identity.location?.trim() || null;
  const where = place ? ` in ${place}` : '';

  const queries: Array<{ category: IntelligenceCategory; request: WebSearchRequest }> = [
    {
      category: 'brand_news',
      request: {
        query: `"${brandName}" news announcements launches results`,
        topic: 'news',
        recencyDays: 30,
        maxResults: RESULTS_PER_QUERY,
      },
    },
  ];

  const named = competitors.slice(0, 3);
  queries.push({
    category: 'competitor',
    request: {
      query: named.length
        ? `recent news announcements launches: ${named.join(', ')}`
        : // No names on file: ask who the rivals are rather than returning
          // nothing. A brand that never filled in competitors still has them.
          `top competitors of ${brandName}${industry ? ` ${industry}` : ''}${where} market share news`,
      topic: 'news',
      recencyDays: 30,
      maxResults: RESULTS_PER_QUERY,
    },
  });

  // The query that makes the difference between "apparel" and "footwear".
  // Skipped when the brand has not described its industry, since without it
  // this collapses into the pooled query it exists to improve on.
  if (industry) {
    queries.push({
      category: 'industry_news',
      request: {
        query: `${industry} industry news market developments${where}`,
        topic: 'news',
        recencyDays: 30,
        maxResults: RESULTS_PER_QUERY,
      },
    });
  }

  return queries;
}

/**
 * Multi-provider fan-out for competitor search — mirrors
 * `collectPoolSignals` in trend-pool-refresh.ts.
 *
 * Queries every configured provider (Tavily, SerpAPI, …) for competitor
 * news. A development that two independent sources both surface is stronger
 * evidence than either alone, and the synthesis LLM can see which provider
 * flagged what. Individual provider failures are tolerated (same
 * "one failing doesn’t sink the run" rule); all failing re-throws.
 */
async function collectCompetitorSignal(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  request: WebSearchRequest,
): Promise<CollectedSignal[]> {
  const providers: WebSearchService[] = ctx.ai.configuredWebSearches();
  const signals: CollectedSignal[] = [];

  for (const provider of providers) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          provider.search(request, { brandId: brand.id, referenceId: runId }),
          SEARCH_TIMEOUT_MS,
          `intelligence competitor search (${provider.provider})`,
        ),
      );
      await recordCost(ctx, brand.id, runId, cost);
      signals.push({ provider: provider.provider, results });
    } catch (error) {
      console.warn(
        `[intelligence-research] ${provider.provider}/competitor search failed for run ${runId}: ${describeError(error)}`,
      );
    }
  }

  if (signals.length === 0 || signals.every((s) => s.results.length === 0)) {
    // Return a single empty-results signal so the caller can still run
    // synthesis with "search returned nothing" rather than crashing the run.
    return [{ provider: 'none', results: [] }];
  }

  return signals;
}

function describeCompetitorSignalForPrompt(signals: CollectedSignal[]): string {
  const allResults = signals.flatMap((s) =>
    s.results.map((r) => ({ result: r, provider: s.provider })),
  );
  if (allResults.length === 0) return '## COMPETITOR NEWS\n(search returned nothing)';

  const rows = allResults
    .map(({ result, provider }, i) => {
      const date = result.publishedAt ? ` (${result.publishedAt})` : '';
      const snippet = result.snippet.slice(0, MAX_SNIPPET_CHARS);
      return `${i + 1}. [${provider}] [${result.title ?? 'Untitled'}]${date} — ${result.url}\n   ${snippet}`;
    })
    .join('\n');

  return `## COMPETITOR NEWS\n${rows}`;
}

/** Same clip reasoning as the pool relevance schemas above, scoped to the
 *  old full 5-axis intelligence item shape competitor items still use. */
export function clipCompetitorItemCounts(raw: unknown): unknown {
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

const COMPETITOR_SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'whyItMatters', 'urgency', 'score', 'sources'],
        properties: {
          title: { type: 'string', description: 'Short, specific — names what actually happened.' },
          summary: {
            type: 'string',
            description:
              'What actually happened, grounded in the search results above. 2-4 sentences.',
          },
          whyItMatters: {
            type: 'string',
            // The parse below caps this at 400 characters; saying so here is
            // what stops the model overrunning it and forcing a full retry of
            // an otherwise-good synthesis.
            description:
              'The answer to "so what?" for THIS brand specifically. Name the concrete effect: a ' +
              'cost, a risk, an opportunity, a decision to make. Under 400 characters.',
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
                description:
                  "0-100. How directly this affects this brand's business, not its content.",
              },
              industryRelevance: {
                type: 'number',
                description: "0-100. How much this matters to this brand's specific industry.",
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
            description:
              'Only URLs that actually appear in the search results above. Never invent one.',
          },
        },
      },
    },
  },
} as const;

async function synthesizeCompetitorItems(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signal: CollectedSignal,
  category: IntelligenceCategory,
  market: string,
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizeCompetitorItemsOnce(
        ctx,
        runId,
        brand,
        brandContext,
        signal,
        category,
        market,
      );
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[intelligence-research] competitor synthesis rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

/** The model never emits `category` here — every item in this file's
 *  synthesis is a competitor item by construction, since the search feeding
 *  it is competitor-only. Validated against the full item schema minus that
 *  one field, then `category: 'competitor'` is attached mechanically rather
 *  than trusted from the model. */
const competitorItemDraftSchema = intelligenceItemDraftSchema.omit({ category: true });
const competitorSynthesisSchema = z.object({ items: z.array(competitorItemDraftSchema).max(10) });

/** What each per-brand query was actually asking, so the synthesis judges
 *  results against that question rather than defaulting to competitor
 *  framing for everything. */
const BRAND_QUERY_BRIEF: Record<string, string> = {
  brand_news:
    'developments about the brand itself — its own announcements, launches, results, coverage and reputation',
  competitor:
    'developments at rival businesses that compete with this brand for the same customers',
  industry_news:
    "developments across the brand's specific industry — demand, supply, materials, pricing, regulation and channel shifts",
  government_policy: 'policy, regulation and tax changes affecting this business',
  local: "developments in the brand's own city or region",
};

async function synthesizeCompetitorItemsOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signal: CollectedSignal,
  category: IntelligenceCategory,
  market: string,
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<z.infer<typeof competitorSynthesisSchema>>(
          {
            role: 'orchestrator',
            system:
              dateGrounding(market) +
              'You are a business intelligence analyst keeping one small business owner ' +
              `informed. These search results are about ${BRAND_QUERY_BRIEF[category] ?? category}. ` +
              'You work ONLY from the search results you are given — never invent a fact or a ' +
              'date that is not actually present in the results.\n\n' +
              'Judge the results against that question specifically. Results drift: a search ' +
              "about one brand returns rivals, an industry search returns one company's press " +
              'release. Keep what genuinely answers the question asked and drop the rest.\n\n' +
              'This is NOT a content-ideas feed. The question for every item is: does the brand ' +
              'owner need to know this competitor development to run their business well? If ' +
              'nothing genuinely relevant surfaced, return fewer items — or none — rather than ' +
              'manufacturing a weak one to fill a quota.',
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  '',
                  '**Live search results:**',
                  describeCompetitorSignalForPrompt([signal]),
                  '',
                  'Produce up to 10 ranked items. `whyItMatters` must name the concrete effect on ' +
                    'THIS brand.',
                  'Every `sources` entry must be a URL that literally appears above, and there must ' +
                    'be no more than 5 per item. Do not cite anything else, and do not paraphrase a ' +
                    'URL from memory.',
                ].join('\n'),
              },
            ],
            maxTokens: MAX_COMPETITOR_SYNTHESIS_TOKENS,
            schema: COMPETITOR_SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => competitorSynthesisSchema.parse(clipCompetitorItemCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        COMPETITOR_SYNTHESIS_TIMEOUT_MS,
        'competitor intelligence synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[intelligence-research] competitor synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  const items: IntelligenceItemDraft[] = value.items.map((item) => ({
    ...item,
    category: 'competitor' as const,
  }));

  return { items, cost };
}

/** Same fabrication guard as the old `verifyIntelligenceSources`.
 *  Accepts an array of signals since collectCompetitorSignal now fans out
 *  across multiple providers. */
export function verifyCompetitorSources(
  sources: TrendSource[],
  signals: CollectedSignal[],
): TrendSource[] {
  const known = new Set(signals.flatMap((s) => s.results.map((r) => r.url)));
  return sources.filter((source) => known.has(source.url));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

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

  // brandId comes off the row, not the queue payload — see generate.ts's
  // identical comment for why.
  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, run.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${run.brandId} not found`);

  await ctx.db
    .update(schema.intelligenceRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${schema.intelligenceRuns.startedAt}, now())`,
    })
    .where(eq(schema.intelligenceRuns.id, run.id));

  console.warn(
    `[intelligence-research] starting run ${run.id} for brand ${brand.id} ("${brand.name}")`,
  );

  try {
    const brandContext = await getTrendContext(ctx.db, brand.id);
    const categoryKey = await ensureBrandCategoryKey(ctx, brand);
    console.warn(
      `[intelligence-research] run ${run.id}: brand category resolved to '${categoryKey}'`,
    );

    const market = await ensureBrandMarket(ctx, brand);
    const [categoryPool, nationalPool] = await Promise.all([
      ensureFreshIntelligencePool(ctx, { scope: 'category', category: categoryKey, market }),
      ensureFreshIntelligencePool(ctx, { scope: 'national', market }),
    ]);
    const poolItems = [...categoryPool.items, ...nationalPool.items];
    console.warn(
      `[intelligence-research] run ${run.id}: pool loaded — ${categoryPool.items.length} category items + ${nationalPool.items.length} national items = ${poolItems.length} total`,
    );

    const brandQueries = buildBrandIntelligenceQueries({
      brandName: brand.name,
      industry: brandContext.identity.industry,
      location: brandContext.identity.location,
      competitors: brandContext.competitors.map((c) => c.name),
    });
    console.warn(
      `[intelligence-research] run ${run.id}: ${brandQueries.length} per-brand quer${brandQueries.length === 1 ? 'y' : 'ies'} (${brandQueries.map((q) => q.category).join(', ')})`,
    );

    await recordContextSnapshot(ctx.db, {
      brandId: brand.id,
      agentType: 'intelligence',
      snapshot: {
        ...brandContext,
        categoryKey,
        poolRunIds: [categoryPool.runId, nationalPool.runId],
        poolItemCount: poolItems.length,
        brandQueries: brandQueries.map((q) => q.request.query),
      },
    });

    const pooledRows =
      poolItems.length === 0
        ? []
        : await (async () => {
            const { items: drafts, cost } = await scoreIntelligenceRelevance(
              ctx,
              run.id,
              brand,
              brandContext,
              market,
              poolItems,
            );
            await recordCost(ctx, brand.id, run.id, cost);

            return resolveIntelligenceRelevanceDrafts(drafts, poolItems).map(
              ({ poolItem, draft }) => {
                const modelScore: IntelligenceModelScore = {
                  brandRelevance: draft.brandRelevance,
                  industryRelevance: draft.industryRelevance,
                  geographicRelevance: draft.geographicRelevance,
                  recency: poolItem.score.recency,
                  businessImpact: poolItem.score.businessImpact,
                };
                return {
                  runId: run.id,
                  poolItemId: poolItem.id,
                  category: poolItem.category,
                  title: poolItem.title,
                  summary: poolItem.summary,
                  whyItMatters: draft.whyItMatters,
                  urgency: poolItem.urgency,
                  score: { ...modelScore, overall: computeIntelligenceScore(modelScore) },
                  sources: poolItem.sources,
                };
              },
            );
          })();

    // Each category is searched and synthesised independently rather than
    // merged into one prompt: a single synthesis over mixed brand/competitor/
    // industry results reliably collapses onto whichever category had the
    // loudest coverage, which is how a feed ends up with five competitor
    // items and nothing else. One failing category is logged and skipped, not
    // fatal — the pooled rows and the other categories still stand.
    const brandRows = (
      await Promise.all(
        brandQueries.map(async ({ category, request }) => {
          try {
            const signals = await collectCompetitorSignal(ctx, run.id, brand, request);
            if (!signals.some((s) => s.results.length > 0)) return [];

            const mergedSignal = {
              provider: 'merged',
              results: signals.flatMap((s) => s.results),
            };
            const { items, cost } = await synthesizeCompetitorItems(
              ctx,
              run.id,
              brand,
              brandContext,
              mergedSignal,
              category,
              market,
            );
            await recordCost(ctx, brand.id, run.id, cost);

            return (
              items
                // Pooled items are relevance-scored in a separate pass; these
                // are not, so the model's own brandRelevance is the only thing
                // standing between a drifted search result and the user's feed.
                // Search drift is real here — an industry query came back with
                // an unrelated banking acquisition — and the model scores those
                // low while still returning them.
                .filter((item) => item.score.brandRelevance >= MIN_BRAND_RELEVANCE)
                .map((item) => ({
                  runId: run.id,
                  poolItemId: null,
                  // The searched category wins over the model's own guess: this
                  // query was built to answer one question, and letting the model
                  // relabel its answer is how a category silently stays empty.
                  category,
                  title: item.title,
                  summary: item.summary,
                  whyItMatters: item.whyItMatters,
                  urgency: item.urgency,
                  score: { ...item.score, overall: computeIntelligenceScore(item.score) },
                  sources: verifyCompetitorSources(item.sources, signals),
                }))
            );
          } catch (error) {
            console.warn(
              `[intelligence-research] run ${run.id}: ${category} search failed, continuing — ${describeError(error)}`,
            );
            return [];
          }
        }),
      )
    ).flat();

    const rows = [...pooledRows, ...brandRows];

    // Replace rather than append — same BullMQ-redelivery reasoning as
    // trend-research.ts.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.intelligenceItems).where(eq(schema.intelligenceItems.runId, run.id));
      if (rows.length) await tx.insert(schema.intelligenceItems).values(rows);
      await tx
        .update(schema.intelligenceRuns)
        .set({ status: 'succeeded', finishedAt: new Date(), error: null })
        .where(eq(schema.intelligenceRuns.id, run.id));
    });
    console.warn(
      `[intelligence-research] run ${run.id} succeeded: ${rows.length} items (${pooledRows.length} pooled + ${brandRows.length} brand-specific) for ${brand.name}`,
    );

    // Same rule as trend research: notify only on a run that found something,
    // and lead with the most urgent item rather than the count alone. High
    // urgency means the window to act is closing, which is exactly the case
    // where a push earns its interruption.
    if (rows.length > 0) {
      const mostUrgent = rows.reduce((top, row) =>
        row.score.overall > top.score.overall ? row : top,
      );
      await notifyBrandOwner(ctx.db, brand.id, {
        title: `${rows.length} new industry signal${rows.length === 1 ? '' : 's'}`,
        body: mostUrgent.title,
        data: { type: 'intelligence', runId: run.id },
      });
    }
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
