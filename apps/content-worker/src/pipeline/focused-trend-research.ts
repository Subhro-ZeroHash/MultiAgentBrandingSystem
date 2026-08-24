import { describeError, withRetry, withTimeout, type WebSearchResult } from '@bmas/ai';
import {
  renderBrandContextLines,
  schema,
  type Brand,
  type NewTrendOpportunityRow,
  type TrendTaskContext,
} from '@bmas/db';
import {
  computeActionTier,
  computeOpportunityScore,
  campaignTypeSchema,
  outputFormatSchema,
  styleTemplateSchema,
  trendCategorySchema,
  trendContentTypeSchema,
  type CostEvent,
  type TrendModelScore,
  type TrendSource,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { dateGrounding } from './prompt-context.js';

/**
 * Focused trend research — the path a run takes when the user named a subject.
 *
 * Layer B's normal path does no web search at all: it loads the shared
 * category pool (every fashion brand sees the same pool) and asks a model
 * which of those already-found trends fit this brand. That is the right design
 * for "show me what's happening", because one search serves every brand in the
 * category.
 *
 * It is the wrong design the moment a user types a subject into Focus. The pool
 * contains whatever the category sweep happened to find; if the user asks for
 * marathons and the pool holds Fashion Week and Gen Z luxury, a relevance score
 * can only rank those — it cannot invent marathon coverage. The honest outcome
 * of "Focus: Marathons" against that pool is a list about Fashion Week, which
 * is exactly the bug this file fixes.
 *
 * So: a focused run searches the web for the user's actual subject, stores the
 * results as evidence, and synthesises opportunities from them. `locationOverride`
 * is honoured here too — before this it was collected by the UI, written to the
 * row, shown in history, and read by nothing.
 */

const SEARCH_TIMEOUT_MS = 45_000;
const SYNTHESIS_TIMEOUT_MS = 180_000;
const MAX_RESULTS_PER_PROVIDER = 10;
const MAX_RESULTS_TO_MODEL = 16;
/** A named subject is usually an event or a moment, so bias toward recent
 *  coverage rather than whatever ranks best all-time. */
const RECENCY_DAYS = 45;

const focusedOpportunitySchema = z.object({
  title: z.string().min(3).max(160),
  summary: z.string().min(10).max(600),
  recommendation: z.string().min(10).max(600),
  category: trendCategorySchema,
  contentType: trendContentTypeSchema,
  /** Indices into the results the model was shown, so citations are checked
   *  against real sources rather than trusted from the model. */
  sourceIndexes: z.array(z.number().int().min(0)).max(6).default([]),
  productIndex: z.number().int().min(0).nullable().default(null),
  brandRelevance: z.number().int().min(0).max(100),
  audienceRelevance: z.number().int().min(0).max(100),
  popularity: z.number().int().min(0).max(100),
  freshness: z.number().int().min(0).max(100),
  marketingPotential: z.number().int().min(0).max(100),
  productRelevance: z.number().int().min(0).max(100),
  urgency: z.number().int().min(0).max(100),
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  headlineText: z.string().max(80).nullable().default(null),
  offerText: z.string().max(40).nullable().default(null),
  angle: z.string().min(10).max(500),
});

const focusedSynthesisSchema = z.object({
  /** Empty is a legitimate answer: the subject may genuinely have nothing this
   *  brand can act on, and inventing three ideas to avoid an empty screen is
   *  worse than saying so. */
  opportunities: z.array(focusedOpportunitySchema).max(6),
  /** Shown to the user when nothing usable came back. */
  note: z.string().max(300).nullable().default(null),
});

/**
 * Gemini's structured-output validator rejects this schema outright with a
 * bare "Request contains an invalid argument" — no field name, no detail —
 * once the total enum surface across the object gets large enough.
 * `styleTemplate`'s 12 values combined with the other enum fields here
 * (campaignType, outputFormat, category, contentType) crosses whatever that
 * undocumented limit is; confirmed by bisection against the live API, not
 * from Gemini's own docs, which don't mention one. Loosening the single
 * largest enum to a plain string — describing the real choices in text
 * instead of constraining them in the schema — brings the total back under
 * it. Validation doesn't get weaker: `focusedSynthesisSchema.parse(raw)`
 * below still enforces the real enum, and a value outside it fails that
 * parse and retries via the same path as any other malformed response.
 */
const SYNTHESIS_JSON_SCHEMA = z.toJSONSchema(focusedSynthesisSchema) as Record<string, unknown>;
{
  const opportunityProps = (
    (SYNTHESIS_JSON_SCHEMA.properties as Record<string, unknown>).opportunities as Record<
      string,
      unknown
    >
  ).items as Record<string, unknown>;
  const properties = opportunityProps.properties as Record<string, Record<string, unknown>>;
  properties.styleTemplate = {
    type: 'string',
    description: `One of: ${styleTemplateSchema.options.join(', ')}.`,
  };
}

export interface FocusedResearchResult {
  opportunities: NewTrendOpportunityRow[];
  signals: (typeof schema.trendSignals.$inferInsert)[];
  note: string | null;
}

/**
 * Searches for the user's subject and turns the results into opportunities.
 *
 * Returns rows rather than writing them: the caller owns the transaction that
 * swaps a run's opportunities atomically, and splitting that would let a
 * failure here leave a run half-populated.
 */
export async function researchFocusedOpportunities(
  ctx: WorkerContext,
  args: {
    runId: string;
    brand: Brand;
    brandContext: TrendTaskContext;
    focus: string;
    locationOverride: string | null;
  },
): Promise<FocusedResearchResult> {
  const { runId, brand, brandContext, focus, locationOverride } = args;

  // The place matters to the query, not just to the provider's locale knob:
  // providers disagree about what belongs in `locale` (SerpApi and Tavily
  // accept different things), and putting it in the query text works for all
  // of them. Falls back to the brand's own location when no override is given.
  const place = locationOverride?.trim() || brandContext.identity.location || null;
  const query = place ? `${focus} ${place}` : focus;

  const results = await search(ctx, runId, query);
  console.warn(
    `[focused-trend] run ${runId}: "${query}" returned ${results.length} result(s)`,
  );

  if (results.length === 0) {
    return {
      opportunities: [],
      signals: [],
      note: `No current coverage found for "${focus}". Try a broader subject, or leave Focus empty to see what's trending in your category.`,
    };
  }

  const trimmed = results.slice(0, MAX_RESULTS_TO_MODEL);

  const signals = trimmed.map((r) => ({
    runId,
    source: 'web',
    signalType: 'focused',
    topic: focus,
    title: r.title ?? r.url,
    snippet: r.snippet,
    sourceUrl: r.url,
    // Not comparatively ranked the way pool signals are; a flat mid strength
    // records "this is evidence" without implying a score never computed.
    strength: 50,
    publishedAt: r.publishedAt,
  }));

  const { draft, cost } = await synthesise(ctx, brand, brandContext, focus, place, trimmed);
  await recordCost(ctx, brand.id, runId, cost);

  const opportunities = draft.opportunities.map((o) => {
    const product =
      o.productIndex !== null && o.productIndex < brandContext.products.length
        ? brandContext.products[o.productIndex]!
        : null;

    const modelScore: TrendModelScore = {
      brandRelevance: o.brandRelevance,
      audienceRelevance: o.audienceRelevance,
      popularity: o.popularity,
      freshness: o.freshness,
      marketingPotential: o.marketingPotential,
      productRelevance: product ? o.productRelevance : 0,
      urgency: o.urgency,
    };
    const trendScore = Math.round((o.popularity + o.freshness) / 2);
    const overall = computeOpportunityScore({ ...modelScore, trendScore });

    // Citations are resolved from the indices the model returned and dropped
    // when out of range — the same "don't trust, verify" posture the pool path
    // applies, so a hallucinated index yields no source rather than a wrong one.
    const sources: TrendSource[] = o.sourceIndexes
      .map((i) => trimmed[i])
      .filter((r): r is WebSearchResult => Boolean(r))
      .map((r) => ({ title: r.title ?? r.url, url: r.url }));

    return {
      id: crypto.randomUUID(),
      runId,
      poolItemId: null,
      productId: product?.id ?? null,
      topic: focus,
      category: o.category,
      title: o.title,
      summary: o.summary,
      recommendation: o.recommendation,
      contentType: o.contentType,
      score: { ...modelScore, trendScore, overall },
      actionTier: computeActionTier(overall),
      autoTriggered: false,
      autoTriggeredAt: null,
      generationJobIds: [],
      signalCount: sources.length || trimmed.length,
      sources,
      suggestedRequest: {
        campaignType: o.campaignType,
        styleTemplate: o.styleTemplate,
        outputFormat: o.outputFormat,
        headlineText: o.headlineText,
        offerText: o.offerText,
        extraInstructions: o.angle,
      },
    } satisfies NewTrendOpportunityRow;
  });

  return { opportunities, signals, note: draft.note };
}

/** Every configured provider, tolerating individual failures — one provider
 *  being down or rate-limited must not sink a run the other can serve. */
async function search(
  ctx: WorkerContext,
  runId: string,
  query: string,
): Promise<WebSearchResult[]> {
  const providers = ctx.ai.configuredWebSearches();
  if (providers.length === 0) {
    console.warn(`[focused-trend] run ${runId}: no search provider configured`);
    return [];
  }

  const out: WebSearchResult[] = [];
  for (const provider of providers) {
    try {
      const { value: results, cost } = await withRetry(() =>
        withTimeout(
          provider.search(
            { query, recencyDays: RECENCY_DAYS, maxResults: MAX_RESULTS_PER_PROVIDER },
            { referenceId: runId },
          ),
          SEARCH_TIMEOUT_MS,
          `focused search (${provider.provider})`,
        ),
      );
      await recordCost(ctx, null, runId, cost);
      out.push(...results);
    } catch (error) {
      console.warn(
        `[focused-trend] ${provider.provider} failed for "${query}": ${describeError(error)}`,
      );
    }
  }

  // Same page from two providers is one piece of evidence, not two.
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

async function synthesise(
  ctx: WorkerContext,
  brand: Brand,
  brandContext: TrendTaskContext,
  focus: string,
  place: string | null,
  results: WebSearchResult[],
): Promise<{ draft: z.infer<typeof focusedSynthesisSchema>; cost: CostEvent }> {
  const { value: draft, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          system:
            dateGrounding() +
            'You turn live search results about a subject the business owner asked for into ' +
            'content opportunities for their brand.\n\n' +
            'Every opportunity must be grounded in the results below — cite them by index in ' +
            '`sourceIndexes`. Do not introduce facts the results do not support, and do not ' +
            'drift off the requested subject: they asked about this specific thing, and a ' +
            'generic idea about their industry is what they were trying to avoid by asking.\n\n' +
            'Return an empty list if the results genuinely contain nothing this brand can act ' +
            'on, and say why in `note`. An honest empty answer beats an invented one.' +
            (brand.bannedTopics.length
              ? ` Never suggest content touching: ${brand.bannedTopics.join(', ')}.`
              : ''),
          messages: [
            {
              role: 'user',
              content: [
                '**The brand:**',
                ...renderBrandContextLines(brandContext),
                '',
                `**They asked specifically about:** ${focus}${place ? ` (in ${place})` : ''}`,
                brandContext.recentTopics.length
                  ? `\n**Already suggested recently — do not repeat:** ${brandContext.recentTopics.join('; ')}`
                  : '',
                '',
                "**The brand's products, numbered — reference [N] in `productIndex`, or null:**",
                brandContext.products.length
                  ? brandContext.products
                      .map((p, i) => `[${i}] ${p.name}${p.description ? ` — ${p.description}` : ''}`)
                      .join('\n')
                  : 'No products on file.',
                '',
                '**Live search results, numbered — reference [N] in `sourceIndexes`:**',
                ...results.map(
                  (r, i) => `[${i}] ${r.title ?? r.url} — ${r.snippet} (${r.url})`,
                ),
                '',
                'Return up to 4 opportunities, best first.',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          schema: SYNTHESIS_JSON_SCHEMA,
          parse: (raw) => focusedSynthesisSchema.parse(raw),
        },
        { referenceId: brand.id, brandId: brand.id },
      ),
      SYNTHESIS_TIMEOUT_MS,
      'focused-trend:synthesis',
    ),
  );

  return { draft, cost };
}

/** CLAUDE.md rule 5. */
async function recordCost(
  ctx: WorkerContext,
  brandId: string | null,
  runId: string,
  cost: CostEvent,
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: runId,
    provider: cost.provider,
    model: cost.model,
    operation: 'trend:focused-search',
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}
