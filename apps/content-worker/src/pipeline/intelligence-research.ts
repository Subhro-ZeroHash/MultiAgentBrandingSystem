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
  type PoolIntelligenceItemRow,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeIntelligenceScore,
  intelligenceItemDraftSchema,
  intelligenceRelevanceSynthesisSchema,
  type CostEvent,
  type IntelligenceItemDraft,
  type IntelligenceModelScore,
  type IntelligenceRelevanceDraft,
  type IntelligenceResearchJob,
  type TrendSource,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { ensureBrandCategoryKey } from './category-classifier.js';
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
        required: ['poolItemIndex', 'brandRelevance', 'industryRelevance', 'geographicRelevance', 'whyItMatters'],
        properties: {
          poolItemIndex: {
            type: 'integer',
            description: 'The [N] number of the development this score is for.',
          },
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
  poolItems: PoolIntelligenceItemRow[],
): Promise<{ items: IntelligenceRelevanceDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await scoreIntelligenceRelevanceOnce(ctx, runId, brand, brandContext, poolItems);
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
  poolItems: PoolIntelligenceItemRow[],
): Promise<{ items: IntelligenceRelevanceDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: IntelligenceRelevanceDraft[] }>(
          {
            role: 'orchestrator',
            system:
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
  results: WebSearchResult[];
}

/** Only searched when the brand has actually named competitors — an empty
 *  "competitor news" query against no names returns generic noise, worse
 *  than not asking at all. Same guard the old `buildIntelligenceSearchQueries`
 *  applied to its competitor branch. */
function buildCompetitorQuery(competitors: string[]): WebSearchRequest | null {
  const names = competitors.slice(0, 3);
  if (names.length === 0) return null;

  return {
    query: `recent news announcements launches: ${names.join(', ')}`,
    topic: 'news',
    recencyDays: 30,
    maxResults: RESULTS_PER_QUERY,
  };
}

async function collectCompetitorSignal(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  request: WebSearchRequest,
): Promise<CollectedSignal> {
  const { value: results, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.webSearch().search(request, { brandId: brand.id, referenceId: runId }),
      SEARCH_TIMEOUT_MS,
      'intelligence competitor search',
    ),
  );
  await recordCost(ctx, brand.id, runId, cost);
  return { results };
}

function describeCompetitorSignalForPrompt(signal: CollectedSignal): string {
  if (signal.results.length === 0) return '## COMPETITOR NEWS\n(search returned nothing)';

  const rows = signal.results
    .map((result, i) => {
      const date = result.publishedAt ? ` (${result.publishedAt})` : '';
      const snippet = result.snippet.slice(0, MAX_SNIPPET_CHARS);
      return `${i + 1}. [${result.title ?? 'Untitled'}]${date} — ${result.url}\n   ${snippet}`;
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
            description: 'What actually happened, grounded in the search results above. 2-4 sentences.',
          },
          whyItMatters: {
            type: 'string',
            description:
              'The answer to "so what?" for THIS brand specifically. Name the concrete effect: a ' +
              'cost, a risk, an opportunity, a decision to make.',
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

async function synthesizeCompetitorItems(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signal: CollectedSignal,
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizeCompetitorItemsOnce(ctx, runId, brand, brandContext, signal);
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

async function synthesizeCompetitorItemsOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  signal: CollectedSignal,
): Promise<{ items: IntelligenceItemDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<z.infer<typeof competitorSynthesisSchema>>(
          {
            role: 'orchestrator',
            system:
              'You are a business intelligence analyst keeping one small business owner informed ' +
              'about their named competitors. You work ONLY from the search results you are given ' +
              '— never invent a fact or a date that is not actually present in the results.\n\n' +
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
                  describeCompetitorSignalForPrompt(signal),
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

/** Same fabrication guard as the old `verifyIntelligenceSources`. */
export function verifyCompetitorSources(sources: TrendSource[], signal: CollectedSignal): TrendSource[] {
  const known = new Set(signal.results.map((r) => r.url));
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

  console.warn(`[intelligence-research] starting run ${run.id} for brand ${brand.id} ("${brand.name}")`);

  try {
    const brandContext = await getTrendContext(ctx.db, brand.id);
    const categoryKey = await ensureBrandCategoryKey(ctx, brand);
    console.warn(`[intelligence-research] run ${run.id}: brand category resolved to '${categoryKey}'`);

    const [categoryPool, nationalPool] = await Promise.all([
      ensureFreshIntelligencePool(ctx, { scope: 'category', category: categoryKey }),
      ensureFreshIntelligencePool(ctx, { scope: 'national' }),
    ]);
    const poolItems = [...categoryPool.items, ...nationalPool.items];
    console.warn(
      `[intelligence-research] run ${run.id}: pool loaded — ${categoryPool.items.length} category items + ${nationalPool.items.length} national items = ${poolItems.length} total`,
    );

    const competitorQuery = buildCompetitorQuery(brandContext.competitors.map((c) => c.name));
    console.warn(
      `[intelligence-research] run ${run.id}: competitor search ${competitorQuery ? 'will run (named competitors present)' : 'skipped (no named competitors)'}`,
    );

    await recordContextSnapshot(ctx.db, {
      brandId: brand.id,
      agentType: 'intelligence',
      snapshot: {
        ...brandContext,
        categoryKey,
        poolRunIds: [categoryPool.runId, nationalPool.runId],
        poolItemCount: poolItems.length,
        competitorQuery: competitorQuery?.query ?? null,
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
              poolItems,
            );
            await recordCost(ctx, brand.id, run.id, cost);

            return resolveIntelligenceRelevanceDrafts(drafts, poolItems).map(({ poolItem, draft }) => {
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
            });
          })();

    const competitorRows = competitorQuery
      ? await (async () => {
          const signal = await collectCompetitorSignal(ctx, run.id, brand, competitorQuery);
          if (signal.results.length === 0) return [];

          const { items, cost } = await synthesizeCompetitorItems(
            ctx,
            run.id,
            brand,
            brandContext,
            signal,
          );
          await recordCost(ctx, brand.id, run.id, cost);

          return items.map((item) => ({
            runId: run.id,
            poolItemId: null,
            category: item.category,
            title: item.title,
            summary: item.summary,
            whyItMatters: item.whyItMatters,
            urgency: item.urgency,
            score: { ...item.score, overall: computeIntelligenceScore(item.score) },
            sources: verifyCompetitorSources(item.sources, signal),
          }));
        })()
      : [];

    const rows = [...pooledRows, ...competitorRows];

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
      `[intelligence-research] run ${run.id} succeeded: ${rows.length} items (${pooledRows.length} pooled + ${competitorRows.length} competitor) for ${brand.name}`,
    );
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
