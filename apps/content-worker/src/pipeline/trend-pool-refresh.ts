import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '@bmas/ai';
import { eq, inArray, schema, sql } from '@bmas/db';
import {
  CATEGORY_LABELS,
  poolExpiresAt,
  trendPoolSynthesisSchema,
  type CategoryKey,
  type CostEvent,
  type SignalType,
  type TrendCategory,
  type TrendPoolItemDraft,
  type TrendSource,
  marketName,
} from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import {
  describeCalendarForPrompt,
  loadUpcomingCalendar,
  type VerifiedCalendarEvent,
} from './festival-calendar.js';
import { currentMonthInMarket, dateGrounding } from './prompt-context.js';

/**
 * Trend Research — Layer A (Global Pool refresh).
 *
 * The category-scoped counterpart of `trend-research.ts`'s old per-brand
 * search stage: one search+synthesis pass for a whole category (e.g. every
 * Fashion & Apparel brand shares this run's output), or once nationally for
 * `event_festival`, which was never industry-qualified in the query text to
 * begin with. `trend-research.ts` (Layer B) now reads what this produces
 * instead of searching the web itself — see `ensureFreshPool` in
 * pool-loader.ts, which calls this inline when a bucket has gone stale.
 *
 * Deliberately the same two-stage shape as the old per-brand pipeline
 * (deterministic search first, one judgment call clustering it) — only *who*
 * this runs for changes, not *how* it reasons about what it finds.
 */

const SEARCH_TIMEOUT_MS = 15_000;
// Same ceiling as trend-research.ts's RELEVANCE_TIMEOUT_MS, same reasoning —
// see that file's comment. A pool refresh's prompt is the same size class (up
// to ~15 items instead of 8), not meaningfully smaller.
const SYNTHESIS_TIMEOUT_MS = 300_000;
const MAX_SYNTHESIS_TOKENS = 16_000;
const RESULTS_PER_QUERY = 8;
const MAX_SNIPPET_CHARS = 500;

const SIGNAL_TYPE_FOR_CATEGORY: Record<TrendCategory, SignalType> = {
  industry_topic: 'news_mention',
  event_festival: 'event_proximity',
  social_trend: 'social_trend_mention',
};

export type TrendPoolBucket = (
  { scope: 'category'; category: CategoryKey } | { scope: 'national' }
) & { market: string };

/**
 * The pool's queries, built from a category label instead of one brand's
 * context. `industry_topic`/`social_trend` are the two sub-categories that
 * were already industry-qualified in the old per-brand query text — they
 * become category-scoped buckets. `event_festival` never mentioned an
 * industry at all (festivals apply to every business alike), so it becomes
 * the one national bucket trend pooling needs.
 *
 * Pure and exported for the same reason `buildTrendSearchQueries` was:
 * testable query construction without a network call.
 */
export function buildTrendPoolQueries(
  bucket: TrendPoolBucket,
): Array<{ category: TrendCategory; request: WebSearchRequest }> {
  const place = marketName(bucket.market);
  const month = currentMonthInMarket(bucket.market);

  if (bucket.scope === 'national') {
    return [
      {
        category: 'event_festival',
        // Deliberately no longer asks search which festivals are coming up.
        // That question has no answer on any page, so it used to return
        // whatever sale listicle ranked best — the Republic Day result.
        // `festival-calendar.ts` answers it properly now; this query is left
        // to what search is actually good at, which is what is being reported
        // on right now in the market.
        request: {
          query: `what consumers in ${place} are shopping for and talking about right now, ${month}`,
          topic: 'news',
          recencyDays: 14,
          maxResults: RESULTS_PER_QUERY,
        },
      },
    ];
  }

  const industry = CATEGORY_LABELS[bucket.category];

  return [
    {
      category: 'industry_topic',
      request: {
        query: `trending news and current topics this week relevant to ${industry} businesses in ${place}, ${month}`,
        topic: 'news',
        recencyDays: 14,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'social_trend',
      request: {
        query: `trending Instagram Reels formats, audio and hashtags this week for ${industry} brands in ${place}, ${month}`,
        topic: 'general',
        recencyDays: 14,
        maxResults: RESULTS_PER_QUERY,
      },
    },
  ];
}

async function recordCost(ctx: WorkerContext, runId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    // Null on purpose — a pool refresh has no one brand to bill. Every brand
    // in the bucket amortizes this cost by reading the same rows, and
    // `core.cost_events.brand_id` is nullable for exactly this shape of
    // shared, non-brand-specific spend.
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

interface SignalCandidate {
  id: string;
  source: string;
  signalType: SignalType;
  title: string;
  snippet: string;
  strength: number;
  sourceUrl: string;
  publishedAt: string | null;
}

/** Same "one provider/category failing doesn't sink the run, all of them
 *  failing does" logic as trend-research.ts's `collectSignals` — see that
 *  function's comment. */
async function collectPoolSignals(
  ctx: WorkerContext,
  runId: string,
  queries: Array<{ category: TrendCategory; request: WebSearchRequest }>,
): Promise<SignalCandidate[]> {
  const providers = ctx.ai.configuredWebSearches();
  const candidates: SignalCandidate[] = [];

  for (const { category, request } of queries) {
    for (const provider of providers) {
      try {
        const { value: results, cost } = await withRetry(() =>
          withTimeout(
            provider.search(request, { referenceId: runId }),
            SEARCH_TIMEOUT_MS,
            `pool signal search (${provider.provider}/${category})`,
          ),
        );
        await recordCost(ctx, runId, cost);
        candidates.push(...mapResultsToSignals(provider, category, results));
      } catch (error) {
        console.warn(
          `[trend-pool-refresh] ${provider.provider}/${category} search failed for run ${runId}: ${describeError(error)}`,
        );
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      'No signals were collected — every search provider failed or returned nothing.',
    );
  }

  return candidates;
}

function mapResultsToSignals(
  provider: WebSearchService,
  category: TrendCategory,
  results: WebSearchResult[],
): SignalCandidate[] {
  return results.map((result, index) => ({
    id: crypto.randomUUID(),
    source: provider.provider,
    signalType: SIGNAL_TYPE_FOR_CATEGORY[category],
    title: (result.title?.trim() || result.snippet.slice(0, 120).trim() || 'Untitled').slice(
      0,
      300,
    ),
    snippet: result.snippet.slice(0, MAX_SNIPPET_CHARS),
    strength: Math.max(100 - index * 12, 10),
    sourceUrl: result.url,
    publishedAt: result.publishedAt,
  }));
}

/**
 * Turns each verified observance into one signal.
 *
 * One per event, not one per corroborating result: the evidence here is the
 * *observance*, and the pages found about it are corroboration of a single
 * fact, not five independent findings. Emitting one apiece would inflate
 * `popularity`, which the synthesis prompt is explicitly told to read as "how
 * many independent sources surfaced this".
 *
 * `sourceUrl` takes the best corroborating page — every signal must carry one,
 * and an event that reached here has at least one by construction.
 * `publishedAt` stays that page's own date rather than the event date: it means
 * "when this evidence was written", and quietly putting a future date in it
 * would misreport every downstream recency judgment. The event's date is in the
 * title, where it is read as what it is.
 */
export function calendarEventsToSignals(events: VerifiedCalendarEvent[]): SignalCandidate[] {
  return events.flatMap((event) => {
    const top = event.results[0];
    if (!top) return [];
    return [
      {
        id: crypto.randomUUID(),
        source: 'calendar',
        signalType: 'event_proximity' as const,
        title: `${event.name} — ${event.date} (in ${event.daysAway} days)`.slice(0, 300),
        snippet:
          `${event.kind} observance, observed by ${event.audience}. ${event.significance}`.slice(
            0,
            MAX_SNIPPET_CHARS,
          ),
        // Nearer is stronger: the whole value of a dated event is the closing
        // window to act on it. Floored rather than decayed to nothing, since
        // an event six weeks out is still a real planning opportunity.
        strength: Math.max(100 - event.daysAway * 1.5, 40),
        sourceUrl: top.url,
        publishedAt: top.publishedAt,
      },
    ];
  });
}

function describeSignalsForPrompt(signals: SignalCandidate[]): string {
  return signals
    .map((signal, index) => {
      const date = signal.publishedAt ? ` (${signal.publishedAt})` : '';
      return (
        `[${index}] (${signal.source}/${signal.signalType}) ${signal.title}${date} — ${signal.sourceUrl}\n` +
        `   ${signal.snippet}`
      );
    })
    .join('\n');
}

/** Same "clip rather than reject an overshoot" reasoning as
 *  trend-research.ts's `clipOpportunityCounts` — see that function's
 *  comment for why this exists instead of a `maxItems` on the JSON schema
 *  itself. */
export function clipPoolItemCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) return raw;
  const items = (raw as { items: unknown }).items;
  if (!Array.isArray(items)) return raw;

  return { ...raw, items: items.slice(0, 15) };
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
        required: [
          'signalIndexes',
          'topic',
          'category',
          'title',
          'summary',
          'recommendation',
          'contentType',
          'score',
          'suggestedRequest',
        ],
        properties: {
          signalIndexes: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Indexes (the [N] numbers) of every signal below that this opportunity was ' +
              'clustered from. At least one. An opportunity with no listed signals will be ' +
              'discarded, so never invent one to fill a quota.',
          },
          topic: {
            type: 'string',
            description: 'A short canonical name for this cluster, e.g. "FIFA World Cup 2026".',
          },
          category: { enum: ['industry_topic', 'event_festival', 'social_trend'] },
          title: { type: 'string', description: 'Short, specific — names the actual opportunity.' },
          summary: {
            type: 'string',
            description:
              'What this opportunity actually is, grounded in the clustered signals. 2-4 sentences.',
          },
          recommendation: {
            type: 'string',
            description:
              'A concrete instruction, not a description: "Create a Diwali promotional post ' +
              'offering 20% off, timed for the week before." Phrase as something to DO. This is a ' +
              'generic recommendation for the whole category, not one specific business — a later ' +
              'step scores and may refine it per brand.',
          },
          contentType: { enum: ['post', 'reel', 'story', 'campaign'] },
          score: {
            type: 'object',
            additionalProperties: false,
            required: ['popularity', 'freshness', 'marketingPotential'],
            properties: {
              popularity: {
                type: 'number',
                description:
                  '0-100. How much genuine attention this has right now — weigh how many signals ' +
                  "support it and from how many different providers, not just one result's wording.",
              },
              freshness: {
                type: 'number',
                description:
                  '0-100. How current it is — days-old scores far higher than evergreen.',
              },
              marketingPotential: {
                type: 'number',
                description:
                  '0-100. How readily this converts into one piece of content: a clear angle, a ' +
                  'natural offer tie-in, a real date to build toward.',
              },
            },
          },
          suggestedRequest: {
            type: 'object',
            additionalProperties: false,
            required: [
              'campaignType',
              'styleTemplate',
              'outputFormat',
              'headlineText',
              'offerText',
              'extraInstructions',
            ],
            properties: {
              campaignType: { enum: ['offer', 'launch', 'festival', 'generic'] },
              styleTemplate: {
                enum: [
                  'festive',
                  'minimal_luxury',
                  'bold_discount',
                  'flat_lay_product_hero',
                  'studio_white',
                  'lifestyle_in_use',
                  'bold_typographic',
                  'tech_dark_gradient',
                  'neon_gaming',
                  'outdoor_natural_light',
                  'vintage_retro',
                  'playful_pastel',
                ],
              },
              outputFormat: {
                enum: ['instagram_post', 'story_reel_cover', 'facebook_banner', 'poster_a4'],
              },
              headlineText: { type: ['string', 'null'], description: 'Max 80 characters.' },
              offerText: { type: ['string', 'null'], description: 'Max 40 characters.' },
              extraInstructions: {
                type: ['string', 'null'],
                description:
                  "The opportunity's real context, written as direction to a designer. Max 500 characters.",
              },
            },
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
  bucket: TrendPoolBucket,
  signals: SignalCandidate[],
  calendar: VerifiedCalendarEvent[],
): Promise<{ items: TrendPoolItemDraft[]; cost: CostEvent }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizePoolItemsOnce(ctx, runId, bucket, signals, calendar);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[trend-pool-refresh] synthesis rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function synthesizePoolItemsOnce(
  ctx: WorkerContext,
  runId: string,
  bucket: TrendPoolBucket,
  signals: SignalCandidate[],
  calendar: VerifiedCalendarEvent[],
): Promise<{ items: TrendPoolItemDraft[]; cost: CostEvent }> {
  const audience =
    bucket.scope === 'national'
      ? `small businesses across every industry in ${marketName(bucket.market)}`
      : `${CATEGORY_LABELS[bucket.category]} businesses in ${marketName(bucket.market)}`;

  // Both empty for a category bucket, which has no calendar — the prompt is
  // then character-for-character what it was before this existed.
  const calendarBlock = calendar.length
    ? `**Confirmed upcoming calendar for ${marketName(bucket.market)}** — each of these is a real ` +
      `dated observance, checked against live sources for both existence and date. An observance ` +
      `here is a genuine opportunity even if no signal below happens to mention it:` +
      `\n${describeCalendarForPrompt(calendar)}\n`
    : '';
  const calendarInstruction = calendar.length
    ? 'A verified calendar of upcoming dated observances is given alongside the signals. Treat it ' +
      'as established fact — it was confirmed against live sources — and build an opportunity for ' +
      'each observance genuinely worth acting on, whether or not a signal mentions it. Where a ' +
      'signal does relate to one, cluster them together and cite the signal. Where none does, ' +
      'still produce the opportunity and cite the calendar signal carrying that event. A dated ' +
      'observance arriving soon is the single strongest kind of opportunity this pool can ' +
      'surface: there is a fixed date to build toward and a known reason people are already ' +
      'thinking about it.\n\n'
    : '';

  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ items: TrendPoolItemDraft[] }>(
          {
            role: 'orchestrator',
            system:
              dateGrounding(bucket.market) +
              `You are a marketing strategist turning raw search signals into content ` +
              `opportunities for ${audience} generally — not one specific business. You work ` +
              `ONLY from the material you are given below — it is current and verified; your own ` +
              `knowledge is not, and might be stale by months. Never invent a trend, event, date, ` +
              `or fact that is not actually present in that material.\n\n` +
              calendarInstruction +
              'Cluster related signals into opportunities first — several signals about the same ' +
              'topic become ONE opportunity backed by multiple signals, not several near-duplicate ' +
              'opportunities. A topic two independent signal sources both surfaced is stronger ' +
              'evidence than either alone; weigh that in `popularity`.\n\n' +
              'Since no single business is in view yet, judge only how significant and current each ' +
              'opportunity is on its own terms — a later step scores it against one specific ' +
              'brand. If nothing clusters into a genuinely significant opportunity, return fewer — ' +
              'or none — rather than manufacturing a weak one to fill a quota.',
            messages: [
              {
                role: 'user',
                content: [
                  calendarBlock,
                  '**Raw signals collected, numbered — reference these numbers in `signalIndexes`:**',
                  describeSignalsForPrompt(signals),
                  '',
                  'Produce up to 15 ranked opportunities. For `suggestedRequest`, pick the ' +
                    'campaignType, styleTemplate and outputFormat that best fit each opportunity in ' +
                    'general — these prefill an actual generation request once a business picks this ' +
                    'up, so they must be genuinely apt for the opportunity, not a default. Put the ' +
                    "opportunity's real context into `extraInstructions`, written as direction to a " +
                    'designer who has not seen the signals: name the event/topic and why it matters.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_SYNTHESIS_TOKENS,
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => trendPoolSynthesisSchema.parse(clipPoolItemCounts(raw)),
          },
          { referenceId: runId },
        ),
        SYNTHESIS_TIMEOUT_MS,
        'pool opportunity synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[trend-pool-refresh] synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { items: value.items, cost };
}

interface ResolvedPoolItem {
  id: string;
  draft: TrendPoolItemDraft;
  signalIds: string[];
  sources: TrendSource[];
}

/** Same signal-index resolution and "no evidence, no item" backstop as
 *  trend-research.ts's `resolveOpportunitySignals` — see that function's
 *  comment for the full reasoning. */
export function resolvePoolItemSignals(
  drafts: TrendPoolItemDraft[],
  signals: SignalCandidate[],
): ResolvedPoolItem[] {
  return drafts
    .map((draft) => {
      const seen = new Set<number>();
      const resolvedSignals = draft.signalIndexes
        .filter((index) => {
          if (index < 0 || index >= signals.length || seen.has(index)) return false;
          seen.add(index);
          return true;
        })
        .map((index) => signals[index]!);

      const sources: TrendSource[] = [];
      const seenUrls = new Set<string>();
      for (const signal of resolvedSignals) {
        if (seenUrls.has(signal.sourceUrl)) continue;
        seenUrls.add(signal.sourceUrl);
        sources.push({ url: signal.sourceUrl, title: signal.title });
        if (sources.length >= 8) break;
      }

      return {
        id: crypto.randomUUID(),
        draft,
        signalIds: resolvedSignals.map((signal) => signal.id),
        sources,
      };
    })
    .filter((resolved) => resolved.signalIds.length > 0);
}

export async function runTrendPoolRefresh(
  ctx: WorkerContext,
  job: {
    runId: string;
    scope: 'category' | 'national';
    category: CategoryKey | null;
    market: string;
  },
): Promise<void> {
  const [run] = await ctx.db
    .select()
    .from(schema.poolTrendRuns)
    .where(eq(schema.poolTrendRuns.id, job.runId))
    .limit(1);
  if (!run) throw new Error(`Pool trend run ${job.runId} not found`);

  const bucket: TrendPoolBucket =
    job.scope === 'national'
      ? { scope: 'national', market: job.market }
      : { scope: 'category', category: job.category!, market: job.market };

  await ctx.db
    .update(schema.poolTrendRuns)
    .set({ status: 'running', startedAt: sql`coalesce(${schema.poolTrendRuns.startedAt}, now())` })
    .where(eq(schema.poolTrendRuns.id, run.id));

  const bucketLabel = bucket.scope === 'national' ? 'national' : `category:${bucket.category}`;
  console.warn(`[trend-pool-refresh] starting run ${run.id} (${bucketLabel})`);

  try {
    const queries = buildTrendPoolQueries(bucket);
    console.warn(
      `[trend-pool-refresh] run ${run.id}: searching ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} across ${ctx.ai.configuredWebSearches().length} provider(s)...`,
    );

    // Only the national bucket. Festivals are the thing it exists to cover,
    // and a category bucket asks "what is happening in this industry", which
    // is a question search answers perfectly well on its own.
    const calendar =
      bucket.scope === 'national' ? await loadUpcomingCalendar(ctx, run.id, bucket.market) : [];

    // Search first, calendar second — but neither alone is allowed to sink the
    // run. `collectPoolSignals` throws when every provider comes back empty,
    // which used to be correct: with no signals there was nothing to
    // synthesise. A verified calendar is now signal enough on its own, so the
    // throw is caught when one exists.
    let searchSignals: SignalCandidate[] = [];
    try {
      searchSignals = await collectPoolSignals(ctx, run.id, queries);
    } catch (error) {
      if (calendar.length === 0) throw error;
      console.warn(
        `[trend-pool-refresh] run ${run.id}: search produced nothing, continuing on the calendar alone — ${describeError(error)}`,
      );
    }

    const signals = [...calendarEventsToSignals(calendar), ...searchSignals];
    console.warn(
      `[trend-pool-refresh] run ${run.id}: collected ${signals.length} signals (${signals.length - searchSignals.length} calendar, ${searchSignals.length} search)`,
    );

    const signalRows = signals.map((signal) => ({
      id: signal.id,
      runId: run.id,
      source: signal.source,
      signalType: signal.signalType,
      title: signal.title,
      snippet: signal.snippet,
      strength: signal.strength,
      sourceUrl: signal.sourceUrl,
      publishedAt: signal.publishedAt,
    }));

    // Persisted immediately, before synthesis runs — same "raw evidence must
    // outlive the model call that interprets it" reasoning as
    // trend-research.ts. Delete-then-insert for the same BullMQ-redelivery
    // safety a retried run needs.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.poolTrendItems).where(eq(schema.poolTrendItems.runId, run.id));
      await tx.delete(schema.poolTrendSignals).where(eq(schema.poolTrendSignals.runId, run.id));
      if (signalRows.length) await tx.insert(schema.poolTrendSignals).values(signalRows);
    });

    console.warn(
      `[trend-pool-refresh] run ${run.id}: synthesizing opportunities from ${signals.length} signals...`,
    );
    const { items: drafts, cost } = await synthesizePoolItems(
      ctx,
      run.id,
      bucket,
      signals,
      calendar,
    );
    await recordCost(ctx, run.id, cost);

    const resolved = resolvePoolItemSignals(drafts, signals);
    const finishedAt = new Date();

    const itemRows = resolved.map(({ id, draft, signalIds, sources }) => ({
      id,
      runId: run.id,
      topic: draft.topic,
      category: draft.category,
      title: draft.title,
      summary: draft.summary,
      recommendation: draft.recommendation,
      contentType: draft.contentType,
      score: draft.score,
      signalCount: signalIds.length,
      sources,
      suggestedRequest: draft.suggestedRequest,
    }));

    await ctx.db.transaction(async (tx) => {
      if (itemRows.length) await tx.insert(schema.poolTrendItems).values(itemRows);

      for (const { id, draft, signalIds } of resolved) {
        if (signalIds.length === 0) continue;
        await tx
          .update(schema.poolTrendSignals)
          .set({ topic: draft.topic, poolItemId: id })
          .where(inArray(schema.poolTrendSignals.id, signalIds));
      }

      await tx
        .update(schema.poolTrendRuns)
        .set({
          status: 'succeeded',
          finishedAt,
          expiresAt: poolExpiresAt('trend', finishedAt),
          error: null,
        })
        .where(eq(schema.poolTrendRuns.id, run.id));
    });
    console.warn(
      `[trend-pool-refresh] run ${run.id} succeeded: ${itemRows.length} pool items (${bucketLabel})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[trend-pool-refresh] run ${run.id} failed: ${message}`);
    await ctx.db
      .update(schema.poolTrendRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.poolTrendRuns.id, run.id));
    throw error;
  }
}
