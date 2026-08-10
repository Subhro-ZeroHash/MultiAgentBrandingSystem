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

/** `title` is nullish rather than merely nullable because it is filled by a
 *  model, not by us: a small local model constrained by Ollama's JSON-Schema
 *  grammar routinely *omits* an optional-looking string field instead of
 *  emitting `null` for it, which a bare `.nullable()` rejects with
 *  "expected string, received undefined" and — since the adapter marks schema
 *  mismatches retryable — burns the whole research run on a missing headline.
 *  A source is identified by its `url`; the title is a display nicety, so a
 *  missing one normalizes to `null` (the same value the DB column holds) here
 *  rather than failing the item. */
export const trendSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().max(300).nullish().default(null),
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
   *  angle, a natural offer tie-in, a date to build toward. Shown to users as
   *  "Content Potential". */
  marketingPotential: z.number().min(0).max(100),
  /** How well this fits the specific product matched to it (see
   *  `productIndex` on the relevance draft) — distinct from brandRelevance,
   *  since a trend can suit the brand generally but have no real tie-in to
   *  any one product it actually sells. */
  productRelevance: z.number().min(0).max(100),
  /** How time-sensitive acting on this is: a closing window (a festival date
   *  passing, a news cycle fading) scores high; an evergreen angle with no
   *  real deadline scores low. Judged by the model, not derived from
   *  `freshness` alone — freshness is "how new is this", urgency is "how
   *  soon does the window close", and the two can disagree (an old-but-
   *  accelerating trend can still be highly urgent). */
  urgency: z.number().min(0).max(100),
});
export type TrendModelScore = z.infer<typeof trendModelScoreSchema>;

export const trendScoreSchema = trendModelScoreSchema.extend({
  /** How much the trend itself is rising, independent of any one brand —
   *  `round((popularity + freshness) / 2)`. Computed, never asked of the
   *  model directly, same reasoning as `overall` below. Shown to users as
   *  "Trend Score". */
  trendScore: z.number().min(0).max(100),
  /** The ranking number opportunities are sorted by — the "Opportunity
   *  Score". Computed by `computeOpportunityScore` from the axes above,
   *  never asked of the model directly — a self-reported composite can
   *  silently disagree with its own sub-scores, the same failure
   *  `computeGeoScore` in geo/visibility.ts was written to avoid for the GEO
   *  headline number. */
  overall: z.number().min(0).max(100),
});
export type TrendScore = z.infer<typeof trendScoreSchema>;

/** 92+ is worth spending real generation cost on unprompted; below 50 isn't
 *  worth surfacing as actionable at all. See `computeActionTier`. */
export const trendActionTierSchema = z.enum([
  'immediate_action',
  'recommended',
  'monitor',
  'ignore',
]);
export type TrendActionTier = z.infer<typeof trendActionTierSchema>;

export function computeActionTier(overall: number): TrendActionTier {
  if (overall >= 92) return 'immediate_action';
  if (overall >= 75) return 'recommended';
  if (overall >= 50) return 'monitor';
  return 'ignore';
}

/**
 * Weighted so an opportunity that actually fits *this* brand, *this*
 * product, and *this* audience outranks one that is merely popular. An SMB
 * with a narrow niche gets more value from "perfectly on-brand, modest
 * reach" than "huge, generic" — the opposite of what sorting by popularity
 * alone would surface. Product and brand fit are weighted equally and
 * heaviest: an opportunity with no real product tie-in is rarely worth
 * acting on regardless of how well it otherwise fits the brand.
 */
export const OPPORTUNITY_SCORE_WEIGHTS = {
  brandRelevance: 0.2,
  productRelevance: 0.2,
  audienceRelevance: 0.15,
  urgency: 0.15,
  marketingPotential: 0.15,
  trendScore: 0.15,
} as const;

export function computeOpportunityScore(
  score: Omit<TrendModelScore, 'popularity' | 'freshness'> & { trendScore: number },
): number {
  const overall =
    score.brandRelevance * OPPORTUNITY_SCORE_WEIGHTS.brandRelevance +
    score.productRelevance * OPPORTUNITY_SCORE_WEIGHTS.productRelevance +
    score.audienceRelevance * OPPORTUNITY_SCORE_WEIGHTS.audienceRelevance +
    score.urgency * OPPORTUNITY_SCORE_WEIGHTS.urgency +
    score.marketingPotential * OPPORTUNITY_SCORE_WEIGHTS.marketingPotential +
    score.trendScore * OPPORTUNITY_SCORE_WEIGHTS.trendScore;

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

/**
 * One of the 3 content concepts the auto-trigger "Content Strategy Agent"
 * produces for an `immediate_action` opportunity — see
 * `opportunity-trigger.ts`. Each concept becomes exactly one real
 * `CreativeRequest`/`generationJobs` row; there is no intermediate draft
 * state, per the "fully automatic through to generated assets" design.
 */
export const contentConceptSchema = z.object({
  /** Short human-readable name for this concept, e.g. "30-Day Running
   *  Challenge Kickoff" — becomes the generation request's headline. */
  label: z.string().min(1).max(80),
  /** What the post actually shows/does — the creative direction in prose. */
  postConcept: z.string().min(1).max(400),
  captionText: z.string().min(1).max(300),
  hashtags: z.array(z.string().min(1).max(40)).max(10),
  ctaText: z.string().min(1).max(40),
  /** Art-direction detail for composeBrief's free-text escape hatch —
   *  composition, mood, what should be in frame. */
  visualDirection: z.string().min(1).max(400),
  outputFormat: outputFormatSchema,
});
export type ContentConcept = z.infer<typeof contentConceptSchema>;

/** Exactly 3 concepts, each targeting a different output format — "Concept 1
 *  → Poster, Concept 2 → Reel idea, Concept 3 → Story" from the product
 *  brief, left to the model to assign since it knows which format best fits
 *  each concept's angle. */
export const contentConceptSynthesisSchema = z.object({
  concepts: z.array(contentConceptSchema).length(3),
});
export type ContentConceptSynthesis = z.infer<typeof contentConceptSynthesisSchema>;

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

/** One creative asset the auto-trigger pipeline generated from an
 *  opportunity — see `opportunity-trigger.ts`. Enough for the UI to link to
 *  and poll `GET /generations/:jobId` without a separate lookup. */
export const autoTriggeredJobRefSchema = z.object({
  jobId: entityIdSchema,
  label: z.string(),
  outputFormat: outputFormatSchema,
});
export type AutoTriggeredJobRef = z.infer<typeof autoTriggeredJobRefSchema>;

export const trendOpportunitySchema = trendOpportunityDraftSchema
  .omit({ score: true, signalIndexes: true })
  .extend({
    id: entityIdSchema,
    runId: entityIdSchema,
    score: trendScoreSchema,
    /** The single product (of the brand's own catalog) this opportunity was
     *  judged to fit best, or null if none genuinely fit — see
     *  `productIndex` on the relevance draft. Required for auto-trigger,
     *  since a generation request always needs a product. */
    productId: entityIdSchema.nullable(),
    /** Bucketed from `score.overall` by `computeActionTier` at write time —
     *  stored rather than recomputed on read so a later change to the
     *  thresholds doesn't retroactively relabel old opportunities. */
    actionTier: trendActionTierSchema,
    /** Whether the auto-trigger pipeline already generated content for this
     *  opportunity — see `opportunity-trigger.ts`. Guards against
     *  re-triggering the same opportunity on a rerun. */
    autoTriggered: z.boolean(),
    autoTriggeredAt: z.coerce.date().nullable(),
    generationJobIds: z.array(autoTriggeredJobRefSchema).default([]),
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
export type UpdateTrendOpportunityStatusInput = z.infer<typeof updateTrendOpportunityStatusSchema>;

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
