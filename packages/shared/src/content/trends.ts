import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { campaignTypeSchema, outputFormatSchema, styleTemplateSchema } from './creative.js';

/**
 * Trend Research Agent — signal-based.
 *
 * Sits before the creative pipeline, not inside it. Two layers, not one:
 *
 *   1. Trend Signals — raw, unfiltered evidence, one row per result a search
 *      provider actually returned. Stored immediately, before any AI
 *      judgment runs. "FIFA World Cup searches increasing" is a signal;
 *      nobody decided it matters yet.
 *   2. Trend Opportunities — the AI's conclusion after clustering related
 *      signals and judging them against the brand. Five signals about
 *      football and the World Cup become one opportunity, scored for this
 *      specific brand.
 *
 * The distinction is the point: storing only the second layer (what most
 * "trend ideas" features do) means every past judgment is a black box you
 * can't re-derive or audit. Storing the first layer means the evidence
 * outlives the model call that interpreted it — a brand's own history of
 * "what did the internet actually say" independent of any one synthesis run.
 *
 * A user who acts on an opportunity gets a normal generation request
 * (`suggestedRequest` below), prefilled from it; nothing about the existing
 * composeBrief/generateCopy pipeline changes.
 */

// ---------------------------------------------------------------------------
// Trend Signals — raw evidence
// ---------------------------------------------------------------------------

/**
 * Which provider produced this signal. A string union validated here, not a
 * database enum — the whole reason a signal model exists is so adding a new
 * provider (Bing, Reddit, a paid social-listening contract) is new rows under
 * an existing shape, not a migration and an app-wide type change. This union
 * is the one place that has to grow when a provider is added; the database
 * column stays `text`.
 */
export const signalSourceSchema = z.enum(['tavily', 'serpapi']);
export type SignalSource = z.infer<typeof signalSourceSchema>;

/**
 * What kind of evidence this is — not which provider it came from, but what
 * it's evidence *of*. Two providers can both produce a `news_mention`; the
 * type is what lets signals from different sources about the same topic
 * count as corroborating evidence rather than being compared as apples to
 * oranges.
 */
export const signalTypeSchema = z.enum([
  /** A news article or current-topic result — something being reported on. */
  'news_mention',
  /** A festival, holiday, or dated event surfaced by an events/calendar-style
   *  query, with a real date to build toward. */
  'event_proximity',
  /** Approximated via a search-grounded query rather than a dedicated social
   *  API — no such API exposes real trending-hashtag/audio data without a
   *  paid social-listening contract, so this is a best-effort read of what
   *  search surfaces about social activity, not a feed. */
  'social_trend_mention',
]);
export type SignalType = z.infer<typeof signalTypeSchema>;

export const trendSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().max(300).nullable(),
});
export type TrendSource = z.infer<typeof trendSourceSchema>;

/** One piece of raw evidence, before any clustering or brand judgment. */
export const trendSignalSchema = z.object({
  id: entityIdSchema,
  runId: entityIdSchema,
  source: signalSourceSchema,
  signalType: signalTypeSchema,
  /** Null until an opportunity synthesis run clusters this signal under a
   *  canonical name. Several signals share one topic once clustered. */
  topic: z.string().max(160).nullable(),
  title: z.string().min(1).max(300),
  snippet: z.string().max(600),
  /** 0-100. How prominent this one piece of evidence is on its own —
   *  search-rank position, recency, or a provider-reported signal like
   *  interest volume, depending on what the provider actually returned.
   *  Not brand-relevance; that judgment happens once at the opportunity
   *  level, not once per signal. */
  strength: z.number().min(0).max(100),
  sourceUrl: z.string().url(),
  publishedAt: z.string().nullable(),
  /** Set once this signal is clustered into an opportunity. Null for a
   *  signal collection stage that hasn't reached synthesis yet, and stays
   *  null forever for a signal the synthesis judged irrelevant enough not to
   *  cluster — that is a legitimate outcome, not a bug: not every piece of
   *  raw evidence becomes an opportunity. */
  opportunityId: entityIdSchema.nullable(),
  createdAt: z.coerce.date(),
});
export type TrendSignal = z.infer<typeof trendSignalSchema>;

// ---------------------------------------------------------------------------
// Trend Opportunities — the AI's conclusion
// ---------------------------------------------------------------------------

export const trendCategorySchema = z.enum(['industry_topic', 'event_festival', 'social_trend']);
export type TrendCategory = z.infer<typeof trendCategorySchema>;

export const trendContentTypeSchema = z.enum(['post', 'reel', 'story', 'campaign']);
export type TrendContentType = z.infer<typeof trendContentTypeSchema>;

/** What the model is asked to judge. Five separate axes rather than one
 *  relevance number, because an opportunity can be huge and utterly
 *  irrelevant to this brand (high popularity, near-zero brand relevance) or
 *  small but perfectly matched — collapsing them early would lose that
 *  distinction. See the module header's ABC Shoes / XYZ Bakery example:
 *  the same signals, scored against two different brands, should not
 *  converge to the same number. */
export const trendModelScoreSchema = z.object({
  /** How well this fits the brand's industry, products, and voice. */
  brandRelevance: z.number().min(0).max(100),
  /** How well it fits the brand's stated audience specifically. */
  audienceRelevance: z.number().min(0).max(100),
  /** How much genuine attention this has right now, judged from how many
   *  signals support it and how strong they are individually. */
  popularity: z.number().min(0).max(100),
  /** How current it is — days-old news scores far higher than a recurring
   *  evergreen topic dressed up as trending. */
  freshness: z.number().min(0).max(100),
  /** How readily this converts into a concrete piece of content: a clear
   *  angle, a natural offer tie-in, a date to build toward. */
  marketingPotential: z.number().min(0).max(100),
});
export type TrendModelScore = z.infer<typeof trendModelScoreSchema>;

export const trendScoreSchema = trendModelScoreSchema.extend({
  /** The ranking number opportunities are sorted by. Computed by
   *  `computeTrendScore` from the five axes above, never asked of the model
   *  directly — a self-reported composite can silently disagree with its own
   *  sub-scores, the same failure `computeGeoScore` in geo/visibility.ts was
   *  written to avoid for the GEO headline number. */
  overall: z.number().min(0).max(100),
});
export type TrendScore = z.infer<typeof trendScoreSchema>;

/**
 * Weighted so an opportunity that actually fits *this* brand and *this*
 * audience outranks one that is merely popular. An SMB with a narrow niche
 * gets more value from "perfectly on-brand, modest reach" than "huge,
 * generic" — the opposite of what sorting by popularity alone would surface.
 */
export const TREND_SCORE_WEIGHTS = {
  brandRelevance: 0.3,
  audienceRelevance: 0.2,
  marketingPotential: 0.25,
  freshness: 0.15,
  popularity: 0.1,
} as const;

export function computeTrendScore(score: TrendModelScore): number {
  const overall =
    score.brandRelevance * TREND_SCORE_WEIGHTS.brandRelevance +
    score.audienceRelevance * TREND_SCORE_WEIGHTS.audienceRelevance +
    score.marketingPotential * TREND_SCORE_WEIGHTS.marketingPotential +
    score.freshness * TREND_SCORE_WEIGHTS.freshness +
    score.popularity * TREND_SCORE_WEIGHTS.popularity;

  return Math.round(overall);
}

/**
 * Prefills `createGeneration`/the create screen once the user picks an
 * opportunity. Matches `trendSuggestedRequestSchema` on the server field for
 * field.
 */
export const trendSuggestedRequestSchema = z.object({
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  headlineText: z.string().max(80).nullable(),
  offerText: z.string().max(40).nullable(),
  /** Where the opportunity's real context goes — composeBrief already treats
   *  this as a free-text escape hatch (FR-2.4), so the trend agent needs no
   *  new wiring into the brief itself. */
  extraInstructions: z.string().max(500).nullable(),
});
export type TrendSuggestedRequest = z.infer<typeof trendSuggestedRequestSchema>;

/** What the synthesis call produces for one cluster, before a database id, a
 *  computed `overall` score, and the linked signal ids are attached. */
export const trendOpportunityDraftSchema = z.object({
  /** Which signals (by index into the array the model was given) this
   *  opportunity was clustered from. Used to backfill `trend_signals
   *  .opportunity_id` after insert — the provenance link the module header
   *  describes. At least one signal, since an opportunity with no supporting
   *  evidence is exactly the "manufacture something to fill a quota" failure
   *  the prompt is told not to do. */
  signalIndexes: z.array(z.number().int().min(0)).min(1),
  /** A short canonical name for this cluster — "FIFA World Cup 2026", not a
   *  restatement of the brand's angle on it. Written back onto every signal
   *  in the cluster. */
  topic: z.string().min(1).max(160),
  category: trendCategorySchema,
  title: z.string().min(1).max(160),
  /** What this opportunity actually is, grounded in the clustered signals —
   *  not general knowledge. 2-4 sentences. */
  summary: z.string().min(1).max(600),
  /** A concrete instruction, phrased as one: "Create a Diwali promotional
   *  post using the 20%-off angle" — not a description of the opportunity. */
  recommendation: z.string().min(1).max(400),
  contentType: trendContentTypeSchema,
  score: trendModelScoreSchema,
  suggestedRequest: trendSuggestedRequestSchema,
});
export type TrendOpportunityDraft = z.infer<typeof trendOpportunityDraftSchema>;

export const trendOpportunitySynthesisSchema = z.object({
  opportunities: z.array(trendOpportunityDraftSchema).max(8),
});
export type TrendOpportunitySynthesis = z.infer<typeof trendOpportunitySynthesisSchema>;

/** What the user did with an opportunity once it was shown. Mutated in
 *  place — one current state per opportunity, not a history of states. The
 *  append-only side of "ignored"/"worked on" is a row in `brand_preferences`,
 *  written once via `recordFeedbackSignal` when the status changes — this
 *  column is UI state, that table is memory. */
export const trendOpportunityStatusSchema = z.enum(['new', 'saved', 'ignored', 'working_on']);
export type TrendOpportunityStatus = z.infer<typeof trendOpportunityStatusSchema>;

export const trendOpportunitySchema = trendOpportunityDraftSchema
  .omit({ score: true, signalIndexes: true })
  .extend({
    id: entityIdSchema,
    runId: entityIdSchema,
    score: trendScoreSchema,
    /** How many signals were clustered into this opportunity — "5 signals"
     *  is what makes an opportunity legible as a conclusion rather than a
     *  single API's opinion. */
    signalCount: z.number().int().min(1),
    sources: z.array(trendSourceSchema).max(8),
    status: trendOpportunityStatusSchema,
    createdAt: z.coerce.date(),
  });
export type TrendOpportunity = z.infer<typeof trendOpportunitySchema>;

export const updateTrendOpportunityStatusSchema = z.object({
  status: z.enum(['saved', 'ignored', 'working_on']),
});
export type UpdateTrendOpportunityStatusInput = z.infer<
  typeof updateTrendOpportunityStatusSchema
>;

// ---------------------------------------------------------------------------
// Trend Research Runs
// ---------------------------------------------------------------------------

export const trendResearchStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type TrendResearchStatus = z.infer<typeof trendResearchStatusSchema>;

export const trendResearchRunSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  status: trendResearchStatusSchema,
  /** What the run actually searched for — a location override and/or a free
   *  focus line, echoed back so the history view can show what was asked. */
  locationOverride: z.string().nullable(),
  focus: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type TrendResearchRun = z.infer<typeof trendResearchRunSchema>;

/** "Find Trending Content Ideas" — the one input the button needs. Both
 *  fields optional: the common case researches the Brand Kit's own location
 *  and category with no further input from the user. */
export const requestTrendResearchSchema = z.object({
  /** Overrides the Brand Kit's location for this run only — e.g. a brand
   *  planning a pop-up in a city it does not otherwise trade from. */
  locationOverride: z.string().min(1).max(120).optional(),
  /** Steers the research without replacing it — "upcoming sale", "new store
   *  opening" — folded into the search queries alongside the brand context. */
  focus: z.string().min(1).max(300).optional(),
});
export type RequestTrendResearchInput = z.infer<typeof requestTrendResearchSchema>;

/**
 * "Schedule for Approval" — the second destination for a trend opportunity,
 * alongside the existing one-shot /create flow. Creates a single-post
 * scheduled campaign (`totalDays: 1, postsPerDay: 1`) using the
 * opportunity's `suggestedRequest`, so it goes through the normal
 * approval-gated scheduling/publishing pipeline rather than generating
 * instantly. Only a product id is asked for — the opportunity already
 * supplies campaignType/styleTemplate/outputFormat.
 *
 * Known gap: `suggestedRequest.extraInstructions` (the opportunity's actual
 * context, written as designer direction) has nowhere to go — scheduled
 * campaigns have no per-campaign freeform brief field the way a one-shot
 * generation request does. A scheduled post from a trend gets the right
 * product, style and format, but not the trend's specific angle in the
 * brief. Documented rather than silently dropped; giving campaigns a brief
 * field is a larger, separate change.
 */
export const scheduleTrendOpportunitySchema = z.object({
  productId: entityIdSchema,
});
export type ScheduleTrendOpportunityInput = z.infer<typeof scheduleTrendOpportunitySchema>;
