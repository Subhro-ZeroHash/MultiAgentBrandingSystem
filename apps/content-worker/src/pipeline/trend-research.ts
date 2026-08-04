import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '@bmas/ai';
import {
  eq,
  getTrendContext,
  inArray,
  recordContextSnapshot,
  renderBrandContextLines,
  schema,
  sql,
  type Brand,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeTrendScore,
  trendOpportunitySynthesisSchema,
  type CostEvent,
  type SignalType,
  type TrendCategory,
  type TrendOpportunityDraft,
  type TrendResearchJob,
  type TrendSource,
} from '@bmas/shared';
import type { WorkerContext } from '../context.js';

/**
 * Trend Research Agent — signal-based.
 *
 * Two stages, same split used for the website importer: deterministic search
 * first (real, current, sourced — an LLM's training data cannot supply this),
 * then one judgment call on top (`orchestrator` role) to cluster and score
 * what came back. The search stage can never be replaced by asking the model
 * harder; the clustering stage could not be done any other way.
 *
 * What changed from the single-layer version: search results are stored as
 * `trend_signals` — raw, unranked, unfiltered — *before* any AI judgment
 * runs, queried from every configured search provider rather than one. Only
 * afterward does a single LLM call cluster related signals into
 * `trend_opportunities`, each backed by however many signals actually
 * support it. "FIFA World Cup searches increasing" from Tavily and "Football
 * news increasing" from SerpApi are two signals; if the model clusters both
 * under one opportunity, that opportunity is evidenced by two independent
 * providers agreeing, not one API's opinion dressed up as a trend. See the
 * header of packages/shared/src/content/trends.ts for the full reasoning.
 */

const SEARCH_TIMEOUT_MS = 15_000;
// Tuned against the stub adapter's near-instant fixtures during development,
// this was never validated against real search results: three categories of
// real Tavily snippets run well past copy-generation's comparable 60s budget
// (stages.ts) despite a smaller, flatter schema — confirmed live, this timed
// out at 45s on both the first attempt and the retry. Raised well past what a
// real run needs rather than re-tuned to the edge, since search-result size
// (and so prompt size) varies with how much is actually trending, and now
// scales with however many providers are configured.
const SYNTHESIS_TIMEOUT_MS = 120_000;

/**
 * Headroom for up to 8 opportunities, each carrying two prose fields, five
 * scores, a signal-index list, and a suggested request. Sized generously on
 * purpose — the brand-site importer's synthesis call was truncated twice at
 * lower ceilings, and a truncated response here fails the same way:
 * constrained decoding produces valid-looking JSON that doesn't parse. Larger
 * than the single-layer version's ceiling because the prompt now carries
 * every configured provider's results, not just one.
 */
const MAX_SYNTHESIS_TOKENS = 16_000;

/** Per-search-category, per-provider result cap. Two providers at this size
 *  is enough material to cluster from without one provider's results
 *  dominating the synthesis prompt. */
const RESULTS_PER_QUERY = 8;

/** Snippets a provider returns are normally a sentence or two; this is a
 *  defensive ceiling against an unusually long one, not the expected case. */
const MAX_SNIPPET_CHARS = 500;

/** Which kind of evidence a category's search results count as. Independent
 *  of which provider produced them — a `news_mention` from Tavily and one
 *  from SerpApi are the same signal type, just corroborating sources. */
const SIGNAL_TYPE_FOR_CATEGORY: Record<TrendCategory, SignalType> = {
  industry_topic: 'news_mention',
  event_festival: 'event_proximity',
  social_trend: 'social_trend_mention',
};

/**
 * The three searches a research run fans out, built from the Brand Kit plus
 * this run's overrides. Pure and exported so query construction is testable
 * without a network call.
 *
 * Geography goes into the query text, not into `WebSearchRequest.locale`.
 * `brand.location` is a city ("Jaipur"), and a provider's country filter
 * wants a country — mapping one to the other would need a geocoding step
 * this MVP does not have. The query text carries it either way, so nothing
 * is lost by leaving `locale` unset; it stays reserved for when a real
 * country is known.
 */
export function buildTrendSearchQueries(input: {
  brand: Pick<Brand, 'category' | 'location'>;
  locationOverride: string | null;
  focus: string | null;
}): Array<{ category: TrendCategory; request: WebSearchRequest }> {
  const location = input.locationOverride ?? input.brand.location ?? null;
  const industry = input.brand.category?.trim() || 'small business';
  const locality = location ? ` in ${location}` : '';
  const focusLine = input.focus ? `, especially anything related to: ${input.focus}` : '';

  return [
    {
      category: 'industry_topic',
      request: {
        query: `trending news and current topics this week relevant to ${industry} businesses${locality}${focusLine}`,
        topic: 'news',
        recencyDays: 14,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'event_festival',
      request: {
        query: `upcoming festivals, public holidays, product-launch-worthy dates and events in the next 30 days${locality || ' in India'}${focusLine}`,
        topic: 'news',
        recencyDays: 45,
        maxResults: RESULTS_PER_QUERY,
      },
    },
    {
      category: 'social_trend',
      request: {
        query: `trending Instagram Reels formats, audio and hashtags this week for ${industry} brands${locality}${focusLine}`,
        topic: 'general',
        recencyDays: 14,
        maxResults: RESULTS_PER_QUERY,
      },
    },
  ];
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

/** One row of raw evidence, before a database id or clustering. Carries its
 *  own id (generated client-side, not returned from the insert) so the
 *  synthesis prompt's numbered list and the post-synthesis backfill both
 *  reference the exact same row regardless of what order Postgres happens to
 *  return inserted rows in — not a guarantee `RETURNING` actually makes. */
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

/**
 * Runs every category query against every configured search provider.
 *
 * One (provider, category) pair failing does not sink the run — a Tavily
 * hiccup on the events query still leaves SerpApi's events results, or
 * Tavily's other two categories, worth collecting — but every pair failing
 * means there is no real evidence to cluster, which is a hard stop: an LLM
 * asked to invent opportunities from nothing will do exactly that, and this
 * agent exists specifically not to.
 */
async function collectSignals(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  queries: Array<{ category: TrendCategory; request: WebSearchRequest }>,
): Promise<SignalCandidate[]> {
  const providers = ctx.ai.configuredWebSearches();
  const candidates: SignalCandidate[] = [];

  for (const { category, request } of queries) {
    for (const provider of providers) {
      try {
        const { value: results, cost } = await withRetry(() =>
          withTimeout(
            provider.search(request, { brandId: brand.id, referenceId: runId }),
            SEARCH_TIMEOUT_MS,
            `signal search (${provider.provider}/${category})`,
          ),
        );
        await recordCost(ctx, brand.id, runId, cost);
        candidates.push(...mapResultsToSignals(provider, category, results));
      } catch (error) {
        console.warn(
          `[trend-research] ${provider.provider}/${category} search failed for run ${runId}: ${describeError(error)}`,
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

/** Turns one provider's raw results into signal candidates. Strength is a
 *  rank-based heuristic, not a provider-reported number — no search API in
 *  this codebase exposes a uniform relevance score across providers, and a
 *  result's position in its own result list is the one signal every
 *  provider's ranking already encodes. Falls off by 12 points per position,
 *  floored at 10 so even a last-place result still counts as *some*
 *  evidence rather than being silently worthless in the cluster's strength
 *  weighting. */
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

/**
 * Deliberately carries no `maxItems` on either array, unlike most schemas in
 * this codebase. Confirmed by direct testing against the live API: Gemini's
 * structured-output validator rejects this schema outright with an opaque
 * `400 INVALID_ARGUMENT` — no detail beyond that — once `maxItems` co-occurs
 * with the enum-heavy `suggestedRequest` object a few levels down, and the
 * failure disappears the moment either is removed. `clipOpportunityCounts`
 * below is the real enforcement, same split the single-layer version used.
 */
export function clipOpportunityCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('opportunities' in raw)) return raw;
  const opportunities = (raw as { opportunities: unknown }).opportunities;
  if (!Array.isArray(opportunities)) return raw;

  return { ...raw, opportunities: opportunities.slice(0, 8) };
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opportunities'],
  properties: {
    opportunities: {
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
            description:
              'A short canonical name for this cluster, e.g. "FIFA World Cup 2026" — not the ' +
              "brand's angle on it.",
          },
          category: { enum: ['industry_topic', 'event_festival', 'social_trend'] },
          title: { type: 'string', description: 'Short, specific — names the actual opportunity.' },
          summary: {
            type: 'string',
            description: 'What this opportunity actually is, grounded in the clustered signals. 2-4 sentences.',
          },
          recommendation: {
            type: 'string',
            description:
              'A concrete instruction, not a description: "Create a Diwali promotional post ' +
              'offering 20% off, timed for the week before." Phrase every one as something to DO.',
          },
          contentType: { enum: ['post', 'reel', 'story', 'campaign'] },
          score: {
            type: 'object',
            additionalProperties: false,
            required: [
              'brandRelevance',
              'audienceRelevance',
              'popularity',
              'freshness',
              'marketingPotential',
            ],
            properties: {
              brandRelevance: {
                type: 'number',
                description: '0-100. How well this fits the brand\'s industry, products and voice.',
              },
              audienceRelevance: {
                type: 'number',
                description: '0-100. How well this fits the stated target audience specifically.',
              },
              popularity: {
                type: 'number',
                description:
                  '0-100. How much genuine attention this has right now — weigh how many signals ' +
                  'support it and from how many different providers, not just one result\'s wording.',
              },
              freshness: {
                type: 'number',
                description: '0-100. How current it is — days-old scores far higher than evergreen.',
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
                  'The opportunity\'s real context, written as direction to a designer — this is ' +
                  'what reaches the image brief. Max 500 characters.',
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * The judgment call: clusters raw signals into opportunities and scores each
 * against the brand. Runs on `orchestrator` — read once per research run,
 * worth the strongest model available rather than the cheapest one that
 * fans out per platform.
 */
async function synthesizeOpportunities(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  focus: string | null,
  locationOverride: string | null,
  signals: SignalCandidate[],
): Promise<{ opportunities: TrendOpportunityDraft[]; cost: CostEvent }> {
  const location = locationOverride ?? brandContext.identity.location ?? brand.location;

  // Same narrowly-scoped retry as the single-layer version had — see its own
  // prior comment: verified live that this schema and a realistically-sized
  // prompt succeed the large majority of the time; what recurs is Gemini's
  // structured-output validator occasionally rejecting a *valid* complex
  // schema with an opaque `400 INVALID_ARGUMENT`, provider-side flakiness
  // under a schema this deeply nested, not a client error.
  const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizeOpportunitiesOnce(
        ctx,
        runId,
        brand,
        brandContext,
        focus,
        location,
        signals,
      );
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !GEMINI_STRUCTURED_OUTPUT_REJECTION.test(message)) throw error;
      console.warn(
        `[trend-research] synthesis rejected by the provider's structured-output validator for run ${runId}, retrying once: ${message}`,
      );
    }
  }
  throw lastError;
}

async function synthesizeOpportunitiesOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  brandContext: TrendTaskContext,
  focus: string | null,
  location: string | null,
  signals: SignalCandidate[],
): Promise<{ opportunities: TrendOpportunityDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ opportunities: TrendOpportunityDraft[] }>(
          {
            role: 'orchestrator',
            system:
              'You are a marketing strategist turning raw search signals into content ' +
              'opportunities for one specific small business. You work ONLY from the signals you ' +
              'are given below — they are current and real; your own knowledge is not, and might ' +
              'be stale by months. Never invent a trend, event, date, or fact that is not actually ' +
              'present in the signals.\n\n' +
              'Cluster related signals into opportunities first — several signals about the same ' +
              'topic (e.g. "World Cup searches rising" and "football news increasing") become ONE ' +
              'opportunity backed by multiple signals, not several near-duplicate opportunities. ' +
              'A topic two independent signal sources both surfaced is stronger evidence than ' +
              'either alone; weigh that in `popularity`.\n\n' +
              'Relevance is the whole job after that. A topic can have many signals and still be ' +
              'completely wrong for this brand; a lightly-signalled one can be a perfect fit. Score ' +
              'honestly on both axes, not just how many signals support it. If nothing clusters into ' +
              'a genuinely relevant opportunity, return fewer — or none — rather than manufacturing ' +
              'a weak one to fill a quota.' +
              (brand.bannedTopics.length
                ? ` Never suggest content touching: ${brand.bannedTopics.join(', ')} — under any framing.`
                : ''),
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  ...renderBrandContextLines(brandContext),
                  location ? `Location: ${location}.` : '',
                  focus ? `The user is specifically interested in: ${focus}.` : '',
                  brandContext.recentTopics.length
                    ? `\n**Already suggested to this brand recently — do not repeat these, and do not ` +
                      `rephrase them:** ${brandContext.recentTopics.join('; ')}.`
                    : '',
                  '',
                  '**Raw signals collected, numbered — reference these numbers in `signalIndexes`:**',
                  describeSignalsForPrompt(signals),
                  '',
                  'Produce up to 8 ranked opportunities. For `suggestedRequest`, pick the ' +
                    'campaignType, styleTemplate and outputFormat that best fit each opportunity — ' +
                    'these prefill an actual generation request, so they must be genuinely apt, not ' +
                    'a default. Put the opportunity\'s real context into `extraInstructions`, written ' +
                    'as direction to a designer who has not seen the signals: name the event/topic ' +
                    'and why it matters to this brand.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_SYNTHESIS_TOKENS,
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => trendOpportunitySynthesisSchema.parse(clipOpportunityCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        SYNTHESIS_TIMEOUT_MS,
        'opportunity synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[trend-research] synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { opportunities: value.opportunities, cost };
}

/** What one opportunity draft becomes once its signal indexes are resolved
 *  against the real signal candidates and validated. */
interface ResolvedOpportunity {
  id: string;
  draft: TrendOpportunityDraft;
  signalIds: string[];
  sources: TrendSource[];
}

/**
 * Resolves each draft's `signalIndexes` against the actual signal list.
 *
 * A model asked to reference indexes is not a model that reliably stays in
 * bounds — an out-of-range or duplicate index is dropped rather than
 * crashing the run, the same "don't trust, verify" posture the single-layer
 * version's `verifySources` took toward fabricated citations. An opportunity
 * left with zero valid signals after filtering is dropped entirely: an
 * opportunity with no evidence is exactly the "manufactured to fill a quota"
 * failure the prompt is told not to produce, and this is the backstop for
 * when it happens anyway.
 *
 * `sources` is derived mechanically from the resolved signals' URLs rather
 * than asked of the model — every source an opportunity cites is therefore
 * guaranteed to be a real search result by construction, not by a
 * post-hoc fabrication check.
 */
export function resolveOpportunitySignals(
  drafts: TrendOpportunityDraft[],
  signals: SignalCandidate[],
): ResolvedOpportunity[] {
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

export async function runTrendResearch(ctx: WorkerContext, job: TrendResearchJob): Promise<void> {
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

  try {
    const brandContext = await getTrendContext(ctx.db, brand.id);

    const queries = buildTrendSearchQueries({
      brand: {
        category: brandContext.identity.industry ?? brand.category,
        location: brandContext.identity.location ?? brand.location,
      },
      locationOverride: run.locationOverride,
      focus: run.focus,
    });
    await recordContextSnapshot(ctx.db, {
      brandId: brand.id,
      agentType: 'trend',
      snapshot: { ...brandContext, queries: queries.map((query) => query.request.query) },
    });

    const signals = await collectSignals(ctx, run.id, brand, queries);

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

    // Persisted immediately, before synthesis runs — not bundled into the
    // transaction below. This is the entire point of the signal model: raw
    // evidence must outlive the model call that interprets it. If synthesis
    // fails after this (a real, observed failure mode — provider quota,
    // timeout, a rejected schema), the run is marked failed but the signals
    // collected stay queryable via GET .../signals rather than vanishing
    // with the run. Delete-then-insert for the same BullMQ-redelivery
    // reasoning the transaction below has: a retried run must not duplicate
    // signals from the partial attempt before it.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.trendOpportunities).where(eq(schema.trendOpportunities.runId, run.id));
      await tx.delete(schema.trendSignals).where(eq(schema.trendSignals.runId, run.id));
      if (signalRows.length) await tx.insert(schema.trendSignals).values(signalRows);
    });

    const { opportunities: drafts, cost } = await synthesizeOpportunities(
      ctx,
      run.id,
      brand,
      brandContext,
      run.focus,
      run.locationOverride,
      signals,
    );
    await recordCost(ctx, brand.id, run.id, cost);

    const resolved = resolveOpportunitySignals(drafts, signals);

    const opportunityRows = resolved.map(({ id, draft, signalIds, sources }) => ({
      id,
      runId: run.id,
      topic: draft.topic,
      category: draft.category,
      title: draft.title,
      summary: draft.summary,
      recommendation: draft.recommendation,
      contentType: draft.contentType,
      score: { ...draft.score, overall: computeTrendScore(draft.score) },
      signalCount: signalIds.length,
      sources,
      suggestedRequest: draft.suggestedRequest,
    }));

    // Opportunities and the signal->opportunity backfill happen together
    // once synthesis has actually succeeded — the signals themselves are
    // already durable from the transaction above.
    await ctx.db.transaction(async (tx) => {
      if (opportunityRows.length) await tx.insert(schema.trendOpportunities).values(opportunityRows);

      // Backfills the provenance link: which raw evidence a stored
      // opportunity was actually clustered from. One UPDATE per opportunity
      // rather than a single bulk statement — opportunity count is at most
      // 8, so the extra round trips cost nothing worth optimizing away, and
      // it keeps each opportunity's signal set and topic together in one
      // readable statement instead of a harder-to-audit CASE expression.
      for (const { id, draft, signalIds } of resolved) {
        if (signalIds.length === 0) continue;
        await tx
          .update(schema.trendSignals)
          .set({ topic: draft.topic, opportunityId: id })
          .where(inArray(schema.trendSignals.id, signalIds));
      }

      await tx
        .update(schema.trendResearchRuns)
        .set({ status: 'succeeded', finishedAt: new Date(), error: null })
        .where(eq(schema.trendResearchRuns.id, run.id));
    });
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
