import { describeError, withRetry, withTimeout } from '@bmas/ai';
import {
  eq,
  getTrendContext,
  recordContextSnapshot,
  renderBrandContextLines,
  schema,
  sql,
  type Brand,
  type ContextProduct,
  type PoolTrendItemRow,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeActionTier,
  computeOpportunityScore,
  trendRelevanceSynthesisSchema,
  type CostEvent,
  type TrendModelScore,
  type TrendRelevanceDraft,
  type TrendResearchJob,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';
import { ensureBrandCategoryKey } from './category-classifier.js';
import { ensureFreshTrendPool } from './pool-loader.js';
import { triggerAutoOpportunity, type TriggerableOpportunity } from './opportunity-trigger.js';

/**
 * Trend Research Agent — Layer B (brand relevance).
 *
 * No web search happens in this file any more. What used to be one full
 * search-and-cluster pipeline per brand, per click is now: load this brand's
 * category pool (refreshed at most once a day, shared by every brand in that
 * category — see trend-pool-refresh.ts and pool-loader.ts), and run one
 * small LLM call scoring how relevant each already-identified opportunity is
 * to *this specific brand*. "World Cup" might score 95/100 relevance for a
 * sportswear brand and 3/100 for a bakery — the pool item is identical
 * either way; only the judgment made here differs.
 *
 * `trend_research_runs` / `trend_opportunities`, the job schema, the queue,
 * the controller and the frontend all stay exactly as they were — this file
 * is the entire redesign. `GET :runId/signals` now returns `[]` for every
 * new run, since no search happens at this layer any more; the raw evidence
 * a pool item was built from is still queryable directly from
 * `pool_trend_signals`, just not through the per-brand run any more. That is
 * a deliberate, documented v1 gap, not a silent regression.
 */

// Much smaller prompt than the old full-signal synthesis (no raw search
// results, just already-summarized pool items). Confirmed live against
// LLM_PROVIDER=ollama that a smaller prompt does not imply a proportionally
// shorter wall-clock time — local inference cost is dominated by model
// load/decode speed, not prompt size, and a 120s ceiling still timed out
// under load. Matches the 300s headroom every other locally-tested LLM call
// in this codebase already settled on (trend-pool-refresh.ts,
// intelligence-pool-refresh.ts) — raising this costs nothing when the
// response is fast, and only ever matters when a request has stalled.
const RELEVANCE_TIMEOUT_MS = 300_000;
const MAX_RELEVANCE_TOKENS = 4_000;

function describePoolItemsForPrompt(poolItems: PoolTrendItemRow[]): string {
  return poolItems
    .map(
      (item, index) =>
        `[${index}] ${item.title}\n` +
        `   ${item.summary}\n` +
        `   Generic recommendation: ${item.recommendation}\n` +
        `   Popularity: ${item.score.popularity}, Freshness: ${item.score.freshness}, ` +
        `Marketing potential: ${item.score.marketingPotential}`,
    )
    .join('\n\n');
}

/** Numbered so the model can reference a product by `productIndex` the same
 *  way it references a pool item by `poolItemIndex` — see the module doc on
 *  `trendRelevanceDraftSchema` for why an index beats asking for an echoed
 *  id. Empty when the brand has no products yet, in which case the prompt
 *  below tells the model to always answer null. */
function describeProductsForPrompt(products: ContextProduct[]): string {
  if (products.length === 0) return '(none — this brand has no products yet)';
  return products
    .map((product, index) => {
      const details = [
        product.description,
        product.sellingPoints.length ? `Selling points: ${product.sellingPoints.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' — ');
      return `[${index}] ${product.name}${details ? `\n   ${details}` : ''}`;
    })
    .join('\n\n');
}

/** Same "clip rather than reject an overshoot" reasoning as the old
 *  `clipOpportunityCounts`. */
export function clipRelevanceCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) return raw;
  const items = (raw as { items: unknown }).items;
  if (!Array.isArray(items)) return raw;

  return { ...raw, items: items.slice(0, 8) };
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
          'audienceRelevance',
          'productIndex',
          'productRelevance',
          'urgency',
          'recommendationOverride',
        ],
        properties: {
          poolItemIndex: {
            type: 'integer',
            description: 'The [N] number of the opportunity this score is for.',
          },
          brandRelevance: {
            type: 'number',
            description: '0-100. How well this fits the brand\'s industry, products and voice.',
          },
          audienceRelevance: {
            type: 'number',
            description: '0-100. How well this fits the stated target audience specifically.',
          },
          productIndex: {
            type: ['integer', 'null'],
            description:
              'The [N] number of the single best-fitting product from the list given, or null ' +
              'if none genuinely tie in — do not force a weak match just to fill this field.',
          },
          productRelevance: {
            type: 'number',
            description:
              '0-100. How well this opportunity ties into the matched product specifically ' +
              '(0 if productIndex is null).',
          },
          urgency: {
            type: 'number',
            description:
              "0-100. How time-sensitive acting on this is — a closing window (a festival " +
              'date passing, a news cycle fading) scores high; an evergreen angle with no real ' +
              'deadline scores low.',
          },
          recommendationOverride: {
            type: ['string', 'null'],
            description:
              'A brand-specific recommendation, ONLY if this brand\'s real angle genuinely ' +
              'differs from the generic one shown — otherwise null to keep the generic one.',
          },
        },
      },
    },
  },
} as const;

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

const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

/**
 * The one judgment call this agent still makes: given the pool's
 * already-identified opportunities, how relevant is each to this specific
 * brand? Runs on `orchestrator` — still worth the strongest configured
 * model, just against a fraction of the old prompt size.
 */
async function scoreTrendRelevance(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  focus: string | null,
  poolItems: PoolTrendItemRow[],
): Promise<{ items: TrendRelevanceDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await scoreTrendRelevanceOnce(ctx, runId, brand, brandContext, focus, poolItems);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[trend-research] relevance scoring rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function scoreTrendRelevanceOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  focus: string | null,
  poolItems: PoolTrendItemRow[],
): Promise<{ items: TrendRelevanceDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: TrendRelevanceDraft[] }>(
          {
            role: 'orchestrator',
            system:
              'You are a marketing strategist judging how relevant a set of already-identified ' +
              'content opportunities are for ONE SPECIFIC small business. The opportunities below ' +
              'were identified generically for the whole category, not for this brand — your only ' +
              'job is to score how well each one actually fits this brand and its audience, and to ' +
              'write a brand-specific recommendation only when the generic one genuinely does not fit.\n\n' +
              'Score every opportunity honestly. It is correct and expected to give a near-zero ' +
              "score to something popular but irrelevant to this brand, and a high score to " +
              'something with modest reach that fits perfectly. Return only the ones with a real ' +
              'brandRelevance or audienceRelevance — omit anything genuinely irrelevant rather than ' +
              'including it with a low score just to fill a quota.\n\n' +
              'You are also matching each opportunity to the single best-fitting product (or none) ' +
              "from the brand's own catalog, and judging urgency separately from freshness: " +
              'freshness is how new the trend is, urgency is how soon the window to act on it ' +
              'closes. An old-but-accelerating trend can still be highly urgent; a brand-new one ' +
              'with no real deadline is not.' +
              (brand.bannedTopics.length
                ? ` Never suggest content touching: ${brand.bannedTopics.join(', ')} — under any framing.`
                : ''),
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  focus ? `The user is specifically interested in: ${focus}.` : '',
                  brandContext.recentTopics.length
                    ? `\n**Already suggested to this brand recently — score these low, do not repeat ` +
                      `them as a fresh idea:** ${brandContext.recentTopics.join('; ')}.`
                    : '',
                  '',
                  '**The brand\'s products, numbered — reference the [N] number in `productIndex`, ' +
                  'or null if none genuinely fit:**',
                  describeProductsForPrompt(brandContext.products),
                  '',
                  '**Opportunities to score, numbered — reference the [N] number in `poolItemIndex`:**',
                  describePoolItemsForPrompt(poolItems),
                  '',
                  'Return up to 8, ranked by how well they fit this brand.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_RELEVANCE_TOKENS,
            schema: RELEVANCE_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => trendRelevanceSynthesisSchema.parse(clipRelevanceCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        RELEVANCE_TIMEOUT_MS,
        'trend relevance scoring',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[trend-research] relevance scoring attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { items: value.items, cost };
}

/** Resolves each draft's `poolItemIndex` against the real pool item list —
 *  same "don't trust, verify" posture as the old `resolveOpportunitySignals`
 *  toward model-referenced indexes. An out-of-range or duplicate index is
 *  dropped rather than crashing the run. */
export function resolveRelevanceDrafts(
  drafts: TrendRelevanceDraft[],
  poolItems: PoolTrendItemRow[],
): Array<{ poolItem: PoolTrendItemRow; draft: TrendRelevanceDraft }> {
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

/** Auto-triggers content generation for at most one opportunity per run —
 *  the highest-scoring `immediate_action` one — and only when the brand has
 *  opted in via `automation_settings.autoTriggerHighScoreOpportunities`.
 *  Opt-in per brand, capped per run: see this file's header comment at the
 *  call site for why. */
async function maybeAutoTriggerBestOpportunity(
  ctx: WorkerContext,
  brand: Brand,
  opportunityRows: TriggerableOpportunity[],
  contentGenerationQueue: Queue,
  scheduledPostPublishQueue: Queue,
): Promise<void> {
  const [settings] = await ctx.db
    .select({ autoTrigger: schema.automationSettings.autoTriggerHighScoreOpportunities })
    .from(schema.automationSettings)
    .where(eq(schema.automationSettings.brandId, brand.id))
    .limit(1);
  if (!settings?.autoTrigger) return;

  const candidates = opportunityRows.filter((row) => row.actionTier === 'immediate_action' && row.productId);
  if (candidates.length === 0) return;

  const best = candidates.reduce((top, row) => (row.score.overall > top.score.overall ? row : top));
  await triggerAutoOpportunity(ctx, best, brand, contentGenerationQueue, scheduledPostPublishQueue);
}

export async function runTrendResearch(
  ctx: WorkerContext,
  job: TrendResearchJob,
  contentGenerationQueue: Queue,
  scheduledPostPublishQueue: Queue,
): Promise<void> {
  const [run] = await ctx.db
    .select()
    .from(schema.trendResearchRuns)
    .where(eq(schema.trendResearchRuns.id, job.runId))
    .limit(1);
  if (!run) throw new Error(`Trend research run ${job.runId} not found`);

  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  await ctx.db
    .update(schema.trendResearchRuns)
    .set({ status: 'running', startedAt: sql`coalesce(${schema.trendResearchRuns.startedAt}, now())` })
    .where(eq(schema.trendResearchRuns.id, run.id));

  console.warn(`[trend-research] starting run ${run.id} for brand ${brand.id} ("${brand.name}")`);

  try {
    const brandContext = await getTrendContext(ctx.db, brand.id);
    const categoryKey = await ensureBrandCategoryKey(ctx, brand);
    console.warn(`[trend-research] run ${run.id}: brand category resolved to '${categoryKey}'`);

    const [categoryPool, nationalPool] = await Promise.all([
      ensureFreshTrendPool(ctx, { scope: 'category', category: categoryKey }),
      ensureFreshTrendPool(ctx, { scope: 'national' }),
    ]);
    const poolItems = [...categoryPool.items, ...nationalPool.items];
    console.warn(
      `[trend-research] run ${run.id}: pool loaded — ${categoryPool.items.length} category items + ${nationalPool.items.length} national items = ${poolItems.length} total`,
    );

    await recordContextSnapshot(ctx.db, {
      brandId: brand.id,
      agentType: 'trend',
      snapshot: {
        ...brandContext,
        categoryKey,
        poolRunIds: [categoryPool.runId, nationalPool.runId],
        poolItemCount: poolItems.length,
      },
    });

    // A pool with no items is a legitimate outcome (the category genuinely
    // has nothing worth surfacing right now, same "return fewer — or none"
    // allowance the old synthesis prompt always had) — not a failure, and
    // not worth an LLM call to confirm the obvious.
    if (poolItems.length === 0) {
      console.warn(`[trend-research] run ${run.id}: pool is empty, skipping relevance scoring — 0 opportunities`);
    }

    const opportunityRows =
      poolItems.length === 0
        ? []
        : await (async () => {
            console.warn(`[trend-research] run ${run.id}: scoring relevance against ${poolItems.length} pool items for this brand...`);
            const { items: drafts, cost } = await scoreTrendRelevance(
              ctx,
              run.id,
              brand,
              brandContext,
              run.focus,
              poolItems,
            );
            await recordCost(ctx, brand.id, run.id, cost);

            return resolveRelevanceDrafts(drafts, poolItems).map(({ poolItem, draft }) => {
              // Same "don't trust, verify" posture resolveRelevanceDrafts already
              // applies to poolItemIndex — an out-of-range productIndex is treated
              // as "no match" rather than crashing the run.
              const product =
                draft.productIndex !== null &&
                draft.productIndex >= 0 &&
                draft.productIndex < brandContext.products.length
                  ? brandContext.products[draft.productIndex]!
                  : null;

              const trendScore = Math.round((poolItem.score.popularity + poolItem.score.freshness) / 2);
              const modelScore: TrendModelScore = {
                brandRelevance: draft.brandRelevance,
                audienceRelevance: draft.audienceRelevance,
                popularity: poolItem.score.popularity,
                freshness: poolItem.score.freshness,
                marketingPotential: poolItem.score.marketingPotential,
                productRelevance: product ? draft.productRelevance : 0,
                urgency: draft.urgency,
              };
              const overall = computeOpportunityScore({ ...modelScore, trendScore });

              return {
                id: crypto.randomUUID(),
                runId: run.id,
                poolItemId: poolItem.id,
                productId: product?.id ?? null,
                topic: poolItem.topic,
                category: poolItem.category,
                title: poolItem.title,
                summary: poolItem.summary,
                recommendation: draft.recommendationOverride ?? poolItem.recommendation,
                contentType: poolItem.contentType,
                score: { ...modelScore, trendScore, overall },
                actionTier: computeActionTier(overall),
                autoTriggered: false,
                autoTriggeredAt: null,
                generationJobIds: [],
                signalCount: poolItem.signalCount,
                sources: poolItem.sources,
                suggestedRequest: poolItem.suggestedRequest,
              };
            });
          })();

    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.trendOpportunities).where(eq(schema.trendOpportunities.runId, run.id));
      // Defensive: a run.id retried from before this rewrite could carry
      // signals from the old per-brand search stage. New runs never write
      // here any more — see this file's header.
      await tx.delete(schema.trendSignals).where(eq(schema.trendSignals.runId, run.id));

      if (opportunityRows.length) await tx.insert(schema.trendOpportunities).values(opportunityRows);

      await tx
        .update(schema.trendResearchRuns)
        .set({ status: 'succeeded', finishedAt: new Date(), error: null })
        .where(eq(schema.trendResearchRuns.id, run.id));
    });
    console.warn(`[trend-research] run ${run.id} succeeded: ${opportunityRows.length} opportunities for ${brand.name}`);

    // Best-effort, deliberately outside the transaction and its own try/catch:
    // a failure here must never flip a successful research run to 'failed' —
    // the opportunities are already committed and valid on their own. Only
    // the single highest-scoring immediate_action opportunity triggers, not
    // every one a run returns — up to 8 opportunities each spawning 3 paid
    // generation jobs at once is a spend footgun nobody asked for.
    try {
      await maybeAutoTriggerBestOpportunity(
        ctx,
        brand,
        opportunityRows,
        contentGenerationQueue,
        scheduledPostPublishQueue,
      );
    } catch (error) {
      console.error(
        `[trend-research] run ${run.id}: auto-trigger step failed (research run itself still succeeded): ${describeError(error)}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[trend-research] run ${run.id} failed: ${message}`);
    await ctx.db
      .update(schema.trendResearchRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.trendResearchRuns.id, run.id));
    throw error;
  }
}
