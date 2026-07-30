import { describeError, withRetry, withTimeout } from '@bmas/ai';
import type { WebSearchRequest, WebSearchResult } from '@bmas/ai';
import { eq, schema, sql, type Brand } from '@bmas/db';
import {
  computeTrendScore,
  trendResearchSynthesisSchema,
  type CostEvent,
  type TrendCategory,
  type TrendIdeaDraft,
  type TrendResearchJob,
  type TrendSource,
} from '@bmas/shared';
import type { WorkerContext } from '../context.js';

/**
 * Trend Research Agent.
 *
 * Sits upstream of the creative pipeline, not inside it: given a brand, it
 * searches the live web for what's currently relevant, filters that against
 * the Brand Kit, and stores scored, ranked ideas. A user acting on one gets a
 * normal `POST /generations` call prefilled from `suggestedRequest` — nothing
 * in stages.ts changes to support this.
 *
 * Two stages, same split used for the website importer: deterministic search
 * first (real, current, sourced — an LLM's training data cannot supply this),
 * then one judgment call on top (`orchestrator` role) to filter for *this*
 * brand and score what came back. The search stage can never be replaced by
 * asking the model harder; the scoring stage could not be done any other way.
 */

const SEARCH_TIMEOUT_MS = 15_000;
// Tuned against the stub adapter's near-instant fixtures during development,
// this was never validated against real search results: three categories of
// real Tavily snippets run well past copy-generation's comparable 60s budget
// (stages.ts) despite a smaller, flatter schema — confirmed live, this timed
// out at 45s on both the first attempt and the retry. Raised well past what a
// real run needs rather than re-tuned to the edge, since search-result size
// (and so prompt size) varies with how much is actually trending.
const SYNTHESIS_TIMEOUT_MS = 90_000;

/**
 * Headroom for up to 8 ideas, each carrying two prose fields, five scores,
 * up to five sources, and a suggested request. Sized generously on purpose —
 * the brand-site importer's synthesis call was truncated twice at lower
 * ceilings, and a truncated response here fails the same way: constrained
 * decoding produces valid-looking JSON that doesn't parse.
 */
const MAX_SYNTHESIS_TOKENS = 12_000;

/** Per-search-category result cap. Three categories at this size is enough
 *  material to judge relevance from without one category's snippets
 *  dominating the synthesis prompt. */
const RESULTS_PER_QUERY = 8;

/** Snippets a provider returns are normally a sentence or two; this is a
 *  defensive ceiling against an unusually long one, not the expected case. */
const MAX_SNIPPET_CHARS = 500;

interface CollectedSignal {
  category: TrendCategory;
  request: WebSearchRequest;
  results: WebSearchResult[];
}

/**
 * The three searches a research run fans out, built from the Brand Kit plus
 * this run's overrides. Pure and exported so query construction is testable
 * without a network call — the same split `buildTrendSearchQueries`'s
 * counterparts in brand-site use for their own provider-facing shaping.
 *
 * Geography goes into the query text, not into `WebSearchRequest.locale`.
 * `brand.location` is a city ("Jaipur"), and Tavily's country filter wants a
 * country — mapping one to the other would need a geocoding step this MVP
 * does not have. The query text carries it either way, so nothing is lost by
 * leaving `locale` unset; it stays reserved for when a real country is known.
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

/**
 * Runs the three searches. One category failing does not sink the run — a
 * Tavily hiccup on the events query still leaves the other two categories
 * worth synthesising from — but every category failing means there is nothing
 * real to ground the synthesis in, which is a hard stop rather than a
 * degraded result: an LLM asked to invent trends from nothing will do exactly
 * that, and this agent exists specifically not to.
 */
async function collectTrendSignals(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  queries: Array<{ category: TrendCategory; request: WebSearchRequest }>,
): Promise<CollectedSignal[]> {
  const collected: CollectedSignal[] = [];

  for (const { category, request } of queries) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          ctx.ai.webSearch().search(request, { brandId: brand.id, referenceId: runId }),
          SEARCH_TIMEOUT_MS,
          `trend search (${category})`,
        ),
      );
      await recordCost(ctx, brand.id, runId, cost);
      collected.push({ category, request, results });
    } catch (error) {
      console.warn(
        `[trend-research] ${category} search failed for run ${runId}: ${describeError(error)}`,
      );
    }
  }

  if (collected.every((signal) => signal.results.length === 0)) {
    throw new Error(
      'No search results were available to research trends from — every search failed or returned nothing.',
    );
  }

  return collected;
}

function describeSignalsForPrompt(signals: CollectedSignal[]): string {
  const CATEGORY_LABEL: Record<TrendCategory, string> = {
    industry_topic: 'INDUSTRY / CURRENT TOPICS',
    event_festival: 'UPCOMING EVENTS & FESTIVALS',
    social_trend: 'SOCIAL MEDIA (approximated via search — not a dedicated trends API)',
  };

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

/**
 * Deliberately carries no `maxItems` on either array, unlike most schemas in
 * this codebase. Confirmed by direct testing against the live API: Gemini's
 * structured-output validator rejects this schema outright with an opaque
 * `400 INVALID_ARGUMENT` — no detail beyond that — once `maxItems` co-occurs
 * with the enum-heavy `suggestedRequest` object a few levels down, and the
 * failure disappears the moment either is removed. This looks like an
 * undocumented complexity ceiling in how Gemini validates enum-heavy nested
 * schemas, not a mistake in the shape itself — every sub-schema here passes
 * fine in isolation. `trendResearchSynthesisSchema.parse()` (`ideas.max(8)`,
 * `sources.max(5)`) is the real enforcement either way, so nothing is actually
 * unbounded; the prompt asks for the same counts in words instead.
 */
/**
 * Clips array lengths before zod validation.
 *
 * With `maxItems` gone from the JSON schema (see the comment on
 * SYNTHESIS_SCHEMA), nothing stops the model from returning 9 ideas or 6
 * sources — a mild overshoot on an "up to 8" instruction is a realistic
 * outcome, not a malformed response. Without this, `trendResearchSynthesisSchema
 * .parse()` would throw on that overshoot, and a raw ZodError is not one of
 * the errors `withRetry` recognises as retryable, so the entire run would
 * hard-fail over what is fundamentally a cosmetic overage. Clipping first
 * turns that into "a few extra ideas silently dropped".
 */
export function clipSynthesisCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('ideas' in raw)) return raw;
  const ideas = (raw as { ideas: unknown }).ideas;
  if (!Array.isArray(ideas)) return raw;

  return {
    ...raw,
    ideas: ideas.slice(0, 8).map((idea) => {
      if (typeof idea !== 'object' || idea === null || !('sources' in idea)) return idea;
      const sources = (idea as { sources: unknown }).sources;
      return Array.isArray(sources) ? { ...idea, sources: sources.slice(0, 5) } : idea;
    }),
  };
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'category',
          'title',
          'summary',
          'recommendation',
          'contentType',
          'score',
          'sources',
          'suggestedRequest',
        ],
        properties: {
          category: { enum: ['industry_topic', 'event_festival', 'social_trend'] },
          title: { type: 'string', description: 'Short, specific — names the actual trend.' },
          summary: {
            type: 'string',
            description:
              'What this trend actually is, grounded in the search results above. 2-4 sentences.',
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
                description: '0-100. How much genuine attention this has right now.',
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
          sources: {
            // No `maxItems` — see the comment on SYNTHESIS_SCHEMA above.
            // `trendResearchSynthesisSchema` still caps this at 5 after parse.
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
                  'The trend context itself, written as direction to a designer — this is what ' +
                  'reaches the image brief. Max 500 characters.',
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * The judgment call: filters raw search results down to what actually fits
 * this brand, and scores what survives. Runs on `orchestrator` — read once
 * per research run, worth the strongest model available rather than the
 * cheapest one that fans out per platform.
 */
async function synthesizeTrendIdeas(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  focus: string | null,
  locationOverride: string | null,
  signals: CollectedSignal[],
): Promise<{ ideas: TrendIdeaDraft[]; cost: CostEvent }> {
  const location = locationOverride ?? brand.location;

  // One more retry layer than usual, and narrowly scoped to one specific
  // failure: verified live against the real API that this exact schema and a
  // realistically-sized prompt succeed the large majority of the time (5/5 in
  // direct testing) — SYNTHESIS_SCHEMA is not malformed. What recurs is
  // Gemini's structured-output validator occasionally rejecting a *valid*
  // complex schema with an opaque `400 INVALID_ARGUMENT` and no further
  // detail — provider-side flakiness in constrained decoding under a schema
  // this deeply nested, not a client error. `withRetry`'s shared classifier
  // correctly refuses to retry 400s in general (most really are permanent,
  // and retrying those on principle would hide real bugs), so this catches
  // only Google's specific INVALID_ARGUMENT shape rather than loosening that
  // rule for every caller. Kept to one extra attempt: BullMQ's own job-level
  // retry is the backstop beyond this, and re-running the whole job repeats
  // the three searches too, which a synthesis-only retry avoids paying for.
  const GEMINI_STRUCTURED_OUTPUT_REJECTION = /INVALID_ARGUMENT/;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesizeTrendIdeasOnce(ctx, runId, brand, focus, location, signals);
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

async function synthesizeTrendIdeasOnce(
  ctx: WorkerContext,
  runId: string,
  brand: Brand,
  focus: string | null,
  location: string | null,
  signals: CollectedSignal[],
): Promise<{ ideas: TrendIdeaDraft[]; cost: CostEvent }> {
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson<{ ideas: TrendIdeaDraft[] }>(
          {
            role: 'orchestrator',
            system:
              'You are a marketing strategist turning live search results into content ideas for ' +
              'one specific small business. You work ONLY from the search results you are given — ' +
              'they are current and real; your own knowledge is not, and might be stale by months. ' +
              'Never invent a trend, event, date, or fact that is not actually present in the results. ' +
              'If nothing in a category is genuinely relevant to this brand, return fewer ideas — or ' +
              'none from that category — rather than manufacturing a weak one to fill a quota.\n\n' +
              'Relevance is the whole job. A trend can be huge and completely wrong for this brand; a ' +
              "small one can be a perfect fit. Score honestly on both axes, not just popularity." +
              (brand.bannedTopics.length
                ? ` Never suggest content touching: ${brand.bannedTopics.join(', ')} — under any framing.`
                : ''),
            messages: [
              {
                role: 'user',
                content: [
                  '**The brand:**',
                  `Name: ${brand.name}. Industry: ${brand.category ?? 'unspecified'}.`,
                  brand.audience ? `Target audience: ${brand.audience}.` : '',
                  location ? `Location: ${location}.` : '',
                  `Voice: ${brand.tone.join(', ')}.`,
                  brand.languages.length ? `Languages: ${brand.languages.join(', ')}.` : '',
                  focus ? `The user is specifically interested in: ${focus}.` : '',
                  '',
                  '**Live search results, grouped by what was searched for:**',
                  describeSignalsForPrompt(signals),
                  '',
                  'Produce up to 8 ranked ideas. For `suggestedRequest`, pick the campaignType, ' +
                    'styleTemplate and outputFormat that best fit each idea — these prefill an actual ' +
                    'generation request, so they must be genuinely apt, not a default. Put the trend\'s ' +
                    'real context into `extraInstructions`, written as direction to a designer who has ' +
                    'not seen the search results: name the event/topic and why it matters to this brand.',
                  'Every `sources` entry must be a URL that literally appears above, and there must ' +
                    'be no more than 5 per idea. Do not cite anything else, and do not paraphrase a ' +
                    'URL from memory.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_SYNTHESIS_TOKENS,
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => trendResearchSynthesisSchema.parse(clipSynthesisCounts(raw)),
          },
          { brandId: brand.id, referenceId: runId },
        ),
        SYNTHESIS_TIMEOUT_MS,
        'trend synthesis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[trend-research] synthesis attempt ${attempt} failed for run ${runId}, retrying:`,
          describeError(error),
        ),
    },
  );

  return { ideas: value.ideas, cost };
}

/** Drops any citation whose URL was not actually returned by search.
 *
 * A model asked to cite its sources is not a model that reliably cites them
 * correctly — it will occasionally paraphrase a URL from memory or attach one
 * that merely looks plausible. Silently trusting that would put a fabricated
 * link in front of the user as if it were a real source; stripping it here
 * means an idea can lose a citation but never gain a fake one. */
export function verifySources(
  sources: TrendSource[],
  signals: CollectedSignal[],
): TrendSource[] {
  const known = new Set(signals.flatMap((signal) => signal.results.map((r) => r.url)));
  return sources.filter((source) => known.has(source.url));
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
    const queries = buildTrendSearchQueries({
      brand: { category: brand.category, location: brand.location },
      locationOverride: run.locationOverride,
      focus: run.focus,
    });
    const signals = await collectTrendSignals(ctx, run.id, brand, queries);

    const { ideas, cost } = await synthesizeTrendIdeas(
      ctx,
      run.id,
      brand,
      run.focus,
      run.locationOverride,
      signals,
    );
    await recordCost(ctx, brand.id, run.id, cost);

    const rows = ideas.map((idea) => ({
      runId: run.id,
      category: idea.category,
      title: idea.title,
      summary: idea.summary,
      recommendation: idea.recommendation,
      contentType: idea.contentType,
      score: { ...idea.score, overall: computeTrendScore(idea.score) },
      sources: verifySources(idea.sources, signals),
      suggestedRequest: idea.suggestedRequest,
    }));

    // Replace rather than append: a retried run (BullMQ redelivery after a
    // crash between insert and status update) must not duplicate ideas from
    // the partial attempt before it.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.trendIdeas).where(eq(schema.trendIdeas.runId, run.id));
      if (rows.length) await tx.insert(schema.trendIdeas).values(rows);
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
