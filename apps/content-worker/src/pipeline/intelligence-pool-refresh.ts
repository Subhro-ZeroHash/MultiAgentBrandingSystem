import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult } from '@bmas/ai';
import { eq, schema, sql } from '@bmas/db';
import {
  CATEGORY_LABELS,
  intelligencePoolSynthesisSchema,
  poolExpiresAt,
  type CategoryKey,
  type CostEvent,
  type IntelligencePoolItemDraft,
  type PoolableIntelligenceCategory,
  type TrendSource,
} from '@bmas/shared';
import type { WorkerContext } from '../context.js';

/**
 * Intelligence Research — Layer A (Global Pool refresh).
 *
 * The category-scoped counterpart of `intelligence-research.ts`'s old
 * per-brand search stage, for the three categories that are not inherently
 * brand-specific: `government_policy` and `industry_news` (category-scoped —
 * every brand in, say, Fashion & Apparel shares this run) and `local`
 * (national — general local/economic news was never industry-qualified in
 * the query text to begin with). `competitor` stays entirely out of this file
 * and out of the pool: named competitors differ per brand, so there is
 * nothing to share.
 */

const SEARCH_TIMEOUT_MS = 15_000;
const SYNTHESIS_TIMEOUT_MS = 300_000;
const MAX_SYNTHESIS_TOKENS = 14_000;
const RESULTS_PER_QUERY = 6;
const MAX_SNIPPET_CHARS = 500;

export type IntelligencePoolBucket =
  | { scope: 'category'; category: CategoryKey }
  | { scope: 'national' };

interface CollectedSignal {
  category: PoolableIntelligenceCategory;
  request: WebSearchRequest;
  results: WebSearchResult[];
}

/** Pure and exported for the same reason `buildIntelligenceSearchQueries`
 *  was — testable query construction without a network call. Mirrors
 *  `buildTrendPoolQueries`'s category-vs-national split. */
export function buildIntelligencePoolQueries(
  bucket: IntelligencePoolBucket,
): Array<{ category: PoolableIntelligenceCategory; request: WebSearchRequest }> {
  if (bucket.scope === 'national') {
    return [
      {
        category: 'local',
        request: {
          query: 'local business news economic developments opportunities in India',
          topic: 'news',
          recencyDays: 21,
          maxResults: RESULTS_PER_QUERY,
        },
      },
    ];
  }

  const industry = CATEGORY_LABELS[bucket.category];

  return [
    {
      category: 'government_policy',
      request: {
        query: `new government policy regulation tax changes affecting ${industry} businesses in India`,
        topic: 'news',
        recencyDays: 30,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'industry_news',
      request: {
        query: `${industry} industry news market developments trends this month in India`,
        topic: 'news',
        recencyDays: 21,
        maxResults: RESULTS_PER_QUERY,
      },
    },
  ];
}

async function recordCost(ctx: WorkerContext, runId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    // Null on purpose — see trend-pool-refresh.ts's recordCost for why.
    brandId: null,
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

/** Same "one category failing doesn't sink the run, all of them failing
 *  does" logic as intelligence-research.ts's `collectIntelligenceSignals`.
 *  Single-provider (`ctx.ai.webSearch()`), matching today's behavior — the
 *  multi-provider fan-out trend pooling uses is a reasonable future
 *  improvement now that this is amortized across a whole category, but not
 *  required for the pool to work. */
async function collectPoolSignals(
  ctx: WorkerContext,
  runId: string,
  queries: Array<{ category: PoolableIntelligenceCategory; request: WebSearchRequest }>,
): Promise<CollectedSignal[]> {
  const collected: CollectedSignal[] = [];

  for (const { category, request } of queries) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          ctx.ai.webSearch().search(request, { referenceId: runId }),
          SEARCH_TIMEOUT_MS,
          `intelligence pool search (${category})`,
        ),
      );
      await recordCost(ctx, runId, cost);
      collected.push({ category, request, results });
    } catch (error) {
      console.warn(
        `[intelligence-pool-refresh] ${category} search failed for run ${runId}: ${describeError(error)}`,
      );
    }
  }

  if (collected.every((signal) => signal.results.length === 0)) {
    throw new Error(
      'No search results were available to research this bucket from — every search failed or returned nothing.',
    );
  }

  return collected;
}

const CATEGORY_LABEL: Record<PoolableIntelligenceCategory, string> = {
  government_policy: 'GOVERNMENT & POLICY',
  industry_news: 'INDUSTRY NEWS',
  local: 'LOCAL DEVELOPMENTS',
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

/** Same "clip rather than reject an overshoot" reasoning as
 *  trend-pool-refresh.ts's `clipPoolItemCounts`. */
export function clipIntelligencePoolCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) return raw;
  const items = (raw as { items: unknown }).items;
  if (!Array.isArray(items)) return raw;

  return {
    ...raw,
    items: items.slice(0, 15).map((item) => {
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
        required: ['category', 'title', 'summary', 'urgency', 'score', 'sources'],
        properties: {
          category: { enum: ['government_policy', 'industry_news', 'local'] },
          title: { type: 'string', description: 'Short, specific — names what actually happened.' },
          summary: {
            type: 'string',
            description: 'What actually happened, grounded in the search results above. 2-4 sentences.',
          },
          urgency: { enum: ['low', 'medium', 'high'] },
          score: {
            type: 'object',
            additionalProperties: false,
            required: ['businessImpact', 'recency'],
            properties: {
              businessImpact: {
                type: 'number',
                description:
                  '0-100. How consequential this is for a business in this category if it does ' +
                  'nothing about it — judged in general, not for one specific brand yet.',
              },
              recency: { type: 'number', description: '0-100. How current/time-sensitive it is.' },
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

const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

async function synthesizePoolItems(
  ctx: WorkerContext,
  runId: string,
  bucket: IntelligencePoolBucket,
  signals: CollectedSignal[],
): Promise<{ items: IntelligencePoolItemDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizePoolItemsOnce(ctx, runId, bucket, signals);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[intelligence-pool-refresh] synthesis rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function synthesizePoolItemsOnce(
  ctx: WorkerContext,
  runId: string,
  bucket: IntelligencePoolBucket,
  signals: CollectedSignal[],
): Promise<{ items: IntelligencePoolItemDraft[]; cost: CostEvent }> {
  const audience =
    bucket.scope === 'national'
      ? 'small businesses across every industry in India'
      : `${CATEGORY_LABELS[bucket.category]} businesses in India`;

  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: IntelligencePoolItemDraft[] }>(
          {
            role: 'orchestrator',
            system:
              `You are a business intelligence analyst keeping ${audience} informed. You work ` +
              'ONLY from the search results you are given — never invent a policy, a news item, a ' +
              'fact, or a date that is not actually present in the results.\n\n' +
              'This is NOT a content-ideas feed. Do not suggest marketing angles or campaigns. The ' +
              'question for every item is: does a business in this category need to know this to run ' +
              'well — a cost, a risk, a regulatory obligation, an opportunity? If a result is only ' +
              'interesting as a marketing trend and carries no business-decision weight, leave it out.\n\n' +
              'No single business is in view yet — score `businessImpact` for a typical business in ' +
              'this category, not one specific brand; a later step judges relevance to one actual ' +
              'business. If nothing in a category is genuinely significant, return fewer items — or ' +
              'none from that category — rather than manufacturing a weak one to fill a quota.',
            messages: [
              {
                role: 'user',
                content: [
                  '**Live search results, grouped by what was searched for:**',
                  describeSignalsForPrompt(signals),
                  '',
                  'Produce up to 15 ranked items. Score honestly — a huge industry story with low ' +
                    'real business consequence should score low on businessImpact even if recency is ' +
                    'high.',
                  'Every `sources` entry must be a URL that literally appears above, and there must ' +
                    'be no more than 5 per item. Do not cite anything else, and do not paraphrase a ' +
                    'URL from memory.',
                ].join('\n'),
              },
            ],
            maxTokens: MAX_SYNTHESIS_TOKENS,
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => intelligencePoolSynthesisSchema.parse(clipIntelligencePoolCounts(raw)),
          },
          { referenceId: runId },
        ),
        SYNTHESIS_TIMEOUT_MS,
        'pool intelligence synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[intelligence-pool-refresh] synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { items: value.items, cost };
}

/** Same fabrication guard as intelligence-research.ts's
 *  `verifyIntelligenceSources`. */
export function verifyPoolSources(sources: TrendSource[], signals: CollectedSignal[]): TrendSource[] {
  const known = new Set(signals.flatMap((signal) => signal.results.map((r) => r.url)));
  return sources.filter((source) => known.has(source.url));
}

export async function runIntelligencePoolRefresh(
  ctx: WorkerContext,
  job: { runId: string; scope: 'category' | 'national'; category: CategoryKey | null },
): Promise<void> {
  const [run] = await ctx.db
    .select()
    .from(schema.poolIntelligenceRuns)
    .where(eq(schema.poolIntelligenceRuns.id, job.runId))
    .limit(1);
  if (!run) throw new Error(`Pool intelligence run ${job.runId} not found`);

  const bucket: IntelligencePoolBucket =
    job.scope === 'national' ? { scope: 'national' } : { scope: 'category', category: job.category! };

  await ctx.db
    .update(schema.poolIntelligenceRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${schema.poolIntelligenceRuns.startedAt}, now())`,
    })
    .where(eq(schema.poolIntelligenceRuns.id, run.id));

  const bucketLabel = bucket.scope === 'national' ? 'national' : `category:${bucket.category}`;
  console.warn(`[intelligence-pool-refresh] starting run ${run.id} (${bucketLabel})`);

  try {
    const queries = buildIntelligencePoolQueries(bucket);
    console.warn(`[intelligence-pool-refresh] run ${run.id}: searching ${queries.length} categor${queries.length === 1 ? 'y' : 'ies'}...`);
    const signals = await collectPoolSignals(ctx, run.id, queries);
    console.warn(`[intelligence-pool-refresh] run ${run.id}: synthesizing items from search results...`);

    const { items, cost } = await synthesizePoolItems(ctx, run.id, bucket, signals);
    await recordCost(ctx, run.id, cost);

    const finishedAt = new Date();
    const rows = items.map((item) => ({
      runId: run.id,
      category: item.category,
      title: item.title,
      summary: item.summary,
      urgency: item.urgency,
      score: item.score,
      sources: verifyPoolSources(item.sources, signals),
    }));

    // Replace rather than append — same BullMQ-redelivery reasoning as
    // trend-pool-refresh.ts: a retried run must not duplicate items from the
    // partial attempt before it.
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.poolIntelligenceItems)
        .where(eq(schema.poolIntelligenceItems.runId, run.id));
      if (rows.length) await tx.insert(schema.poolIntelligenceItems).values(rows);
      await tx
        .update(schema.poolIntelligenceRuns)
        .set({
          status: 'succeeded',
          finishedAt,
          expiresAt: poolExpiresAt('intelligence', finishedAt),
          error: null,
        })
        .where(eq(schema.poolIntelligenceRuns.id, run.id));
    });
    console.warn(`[intelligence-pool-refresh] run ${run.id} succeeded: ${rows.length} pool items (${bucketLabel})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[intelligence-pool-refresh] run ${run.id} failed: ${message}`);
    await ctx.db
      .update(schema.poolIntelligenceRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.poolIntelligenceRuns.id, run.id));
    throw error;
  }
}
