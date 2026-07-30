import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { campaignTypeSchema, outputFormatSchema, styleTemplateSchema } from './creative.js';

/**
 * Trend Research Agent.
 *
 * Sits before the creative pipeline, not inside it: given a brand, it searches
 * the live web for what is currently relevant — trending topics in the brand's
 * industry, upcoming events and festivals, and an approximation of what is
 * trending on social — filters that against the Brand Kit, and returns scored,
 * ranked ideas. A user who acts on one gets a normal generation request
 * (`suggestedRequest` below), prefilled from the idea; nothing about the
 * existing composeBrief/generateCopy pipeline changes.
 */

export const trendCategorySchema = z.enum([
  /** A current topic, news item, or conversation relevant to the brand's
   *  industry — not evergreen advice, something happening now. */
  'industry_topic',
  /** A festival, holiday, product launch window, or sporting event with a
   *  real date, usable as a campaign trigger. */
  'event_festival',
  /** Approximated via a search-grounded query rather than a dedicated social
   *  API — no such API exposes real trending-hashtag/audio data without a paid
   *  social-listening contract, so this is a best-effort read, not a feed. */
  'social_trend',
]);
export type TrendCategory = z.infer<typeof trendCategorySchema>;

export const trendContentTypeSchema = z.enum(['post', 'reel', 'story', 'campaign']);
export type TrendContentType = z.infer<typeof trendContentTypeSchema>;

/** What the model is asked to judge. Five separate axes rather than one
 *  relevance number, because a trend can be huge and utterly irrelevant to
 *  this brand (high popularity, near-zero brand relevance) or small but
 *  perfectly matched — collapsing them early would lose that distinction. */
export const trendModelScoreSchema = z.object({
  /** How well this fits the brand's industry, products, and voice. */
  brandRelevance: z.number().min(0).max(100),
  /** How well it fits the brand's stated audience specifically. */
  audienceRelevance: z.number().min(0).max(100),
  /** How much attention this trend genuinely has right now. */
  popularity: z.number().min(0).max(100),
  /** How current it is — days-old news scores far higher than a recurring
   *  evergreen topic dressed up as a trend. */
  freshness: z.number().min(0).max(100),
  /** How readily this converts into a concrete piece of content: a clear
   *  angle, a natural offer tie-in, a date to build toward. */
  marketingPotential: z.number().min(0).max(100),
});
export type TrendModelScore = z.infer<typeof trendModelScoreSchema>;

export const trendScoreSchema = trendModelScoreSchema.extend({
  /** The ranking number ideas are sorted by. Computed by `computeTrendScore`
   *  from the five axes above, never asked of the model directly — a
   *  self-reported composite can silently disagree with its own sub-scores,
   *  the same failure `computeGeoScore` in geo/visibility.ts was written to
   *  avoid for the GEO headline number. */
  overall: z.number().min(0).max(100),
});
export type TrendScore = z.infer<typeof trendScoreSchema>;

/**
 * Weighted so a trend that actually fits *this* brand and *this* audience
 * outranks one that is merely popular. An SMB with a narrow niche gets more
 * value from "perfectly on-brand, modest reach" than "huge, generic" — the
 * opposite of what sorting by popularity alone would surface.
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

export const trendSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().max(300).nullable(),
});
export type TrendSource = z.infer<typeof trendSourceSchema>;

/**
 * Prefills a generation request when the user acts on an idea.
 *
 * Deliberately the existing `CreativeRequest` shape minus `brandId` and
 * `productId` — the agent knows the brand, not which product the user wants to
 * advertise against this trend, so the app fills those in after the user
 * picks one. Every field here is a starting point the user can still edit
 * before submitting; nothing about the trend agent bypasses review.
 */
export const trendSuggestedRequestSchema = z.object({
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  headlineText: z.string().max(80).nullable(),
  offerText: z.string().max(40).nullable(),
  /** Where the trend's actual context goes — composeBrief already treats this
   *  as a free-text escape hatch (FR-2.4), so the trend agent needs no new
   *  wiring into the brief itself. */
  extraInstructions: z.string().max(500).nullable(),
});
export type TrendSuggestedRequest = z.infer<typeof trendSuggestedRequestSchema>;

/** What the synthesis call produces for one idea, before a database id and a
 *  computed `overall` score are attached. */
export const trendIdeaDraftSchema = z.object({
  category: trendCategorySchema,
  title: z.string().min(1).max(160),
  /** What the trend actually is, in the model's own words — grounded in the
   *  search results it was given, not general knowledge. */
  summary: z.string().min(1).max(600),
  /** The concrete instruction, phrased as one: "Create a Diwali promotional
   *  post using the 20%-off angle" — not a description of the opportunity. */
  recommendation: z.string().min(1).max(400),
  contentType: trendContentTypeSchema,
  score: trendModelScoreSchema,
  /** Titles and URLs the summary is drawn from. Cross-checked against the
   *  actual search results at synthesis time — a model asked to cite is not a
   *  model that reliably cites correctly, so an idea whose sources don't
   *  survive that check is dropped rather than shipped with a fabricated link. */
  sources: z.array(trendSourceSchema).max(5),
  suggestedRequest: trendSuggestedRequestSchema,
});
export type TrendIdeaDraft = z.infer<typeof trendIdeaDraftSchema>;

export const trendResearchSynthesisSchema = z.object({
  ideas: z.array(trendIdeaDraftSchema).max(8),
});
export type TrendResearchSynthesis = z.infer<typeof trendResearchSynthesisSchema>;

export const trendIdeaSchema = trendIdeaDraftSchema
  .omit({ score: true })
  .extend({
    id: entityIdSchema,
    runId: entityIdSchema,
    score: trendScoreSchema,
    createdAt: z.coerce.date(),
  });
export type TrendIdea = z.infer<typeof trendIdeaSchema>;

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

/**
 * "Find Trending Content Ideas" — the one input the button needs. Both fields
 * optional: the common case researches the Brand Kit's own location and
 * category with no further input from the user.
 */
export const requestTrendResearchSchema = z.object({
  /** Overrides the Brand Kit's location for this run only — e.g. a brand
   *  planning a pop-up in a city it does not otherwise trade from. */
  locationOverride: z.string().min(1).max(120).optional(),
  /** Steers the research without replacing it — "upcoming sale", "new store
   *  opening" — folded into the search queries alongside the brand context. */
  focus: z.string().min(1).max(300).optional(),
});
export type RequestTrendResearchInput = z.infer<typeof requestTrendResearchSchema>;
