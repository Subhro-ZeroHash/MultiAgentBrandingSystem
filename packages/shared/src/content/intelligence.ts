import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { trendSourceSchema } from './trends.js';

/**
 * Leads / Business Intelligence Agent.
 *
 * Same shape as the Trend Research Agent (search → brand-aware judgment call →
 * scored, sourced rows) but answers a different question. Trend research asks
 * "can this become a piece of content?"; this asks "should the brand owner
 * know about this?" Government policy, competitor moves, industry shifts and
 * local developments are useful precisely because they are *not* content
 * ideas — conflating the two feeds would bury a tax-policy change under
 * festival post ideas, so they stay two agents, two tables, two feeds, sharing
 * only the search/synthesize/verify machinery each already needs on its own.
 */

export const intelligenceCategorySchema = z.enum([
  'government_policy',
  'brand_news',
  'industry_news',
  'competitor',
  'local',
]);
export type IntelligenceCategory = z.infer<typeof intelligenceCategorySchema>;

/** Read urgency, not marketing urgency — "act on this soon" for a business
 *  decision, unrelated to a trend's "post about this while it's fresh". */
export const intelligenceUrgencySchema = z.enum(['low', 'medium', 'high']);
export type IntelligenceUrgency = z.infer<typeof intelligenceUrgencySchema>;

/** What the user did with a lead once it was shown to them. Mutated in place
 *  (unlike `brand_preferences`, which is append-only) — a leads inbox has one
 *  current state per item, not a history of states worth keeping. The
 *  append-only side of this is `brand_preferences`, written once when the
 *  status is set via `recordFeedbackSignal`. */
export const intelligenceItemStatusSchema = z.enum(['new', 'read', 'saved', 'dismissed']);
export type IntelligenceItemStatus = z.infer<typeof intelligenceItemStatusSchema>;

/** Mirrors `trendModelScoreSchema`'s reasoning: separate axes because a
 *  development can be hugely important to the industry and irrelevant to this
 *  one brand, or the reverse. */
export const intelligenceModelScoreSchema = z.object({
  /** How directly this affects this brand's business (not its content). */
  brandRelevance: z.number().min(0).max(100),
  /** How much it matters to this brand's specific industry. */
  industryRelevance: z.number().min(0).max(100),
  /** How much it matters given the brand's trading location. */
  geographicRelevance: z.number().min(0).max(100),
  /** How current/time-sensitive it is. */
  recency: z.number().min(0).max(100),
  /** How consequential this is if the brand does nothing about it. */
  businessImpact: z.number().min(0).max(100),
});
export type IntelligenceModelScore = z.infer<typeof intelligenceModelScoreSchema>;

export const intelligenceScoreSchema = intelligenceModelScoreSchema.extend({
  overall: z.number().min(0).max(100),
});
export type IntelligenceScore = z.infer<typeof intelligenceScoreSchema>;

/** Weighted toward business impact and brand relevance over recency —
 *  yesterday's minor update should not outrank a slower-breaking policy
 *  change that will actually cost or save the business money. */
export const INTELLIGENCE_SCORE_WEIGHTS = {
  businessImpact: 0.3,
  brandRelevance: 0.25,
  industryRelevance: 0.2,
  geographicRelevance: 0.15,
  recency: 0.1,
} as const;

export function computeIntelligenceScore(score: IntelligenceModelScore): number {
  const overall =
    score.businessImpact * INTELLIGENCE_SCORE_WEIGHTS.businessImpact +
    score.brandRelevance * INTELLIGENCE_SCORE_WEIGHTS.brandRelevance +
    score.industryRelevance * INTELLIGENCE_SCORE_WEIGHTS.industryRelevance +
    score.geographicRelevance * INTELLIGENCE_SCORE_WEIGHTS.geographicRelevance +
    score.recency * INTELLIGENCE_SCORE_WEIGHTS.recency;

  return Math.round(overall);
}

/** What the synthesis call produces for one lead, before a database id and a
 *  computed `overall` score are attached. Reuses `trendSourceSchema` — a
 *  {url, title} pair means the same thing in both agents. */
export const intelligenceItemDraftSchema = z.object({
  category: intelligenceCategorySchema,
  title: z.string().min(1).max(160),
  /** What actually happened/changed, grounded in the search results. */
  summary: z.string().min(1).max(600),
  /** Why *this* brand specifically should care — the answer to "so what?" */
  whyItMatters: z.string().min(1).max(400),
  urgency: intelligenceUrgencySchema,
  score: intelligenceModelScoreSchema,
  sources: z.array(trendSourceSchema).max(5),
});
export type IntelligenceItemDraft = z.infer<typeof intelligenceItemDraftSchema>;

export const intelligenceSynthesisSchema = z.object({
  items: z.array(intelligenceItemDraftSchema).max(10),
});
export type IntelligenceSynthesis = z.infer<typeof intelligenceSynthesisSchema>;

export const intelligenceItemSchema = intelligenceItemDraftSchema.omit({ score: true }).extend({
  id: entityIdSchema,
  runId: entityIdSchema,
  score: intelligenceScoreSchema,
  status: intelligenceItemStatusSchema,
  createdAt: z.coerce.date(),
});
export type IntelligenceItem = z.infer<typeof intelligenceItemSchema>;

export const intelligenceRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type IntelligenceRunStatus = z.infer<typeof intelligenceRunStatusSchema>;

export const intelligenceRunSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  status: intelligenceRunStatusSchema,
  error: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type IntelligenceRun = z.infer<typeof intelligenceRunSchema>;

/** "Refresh My Intelligence Feed" — no required input; the run always uses the
 *  active brand's full context, unlike trend research's optional focus/
 *  location override, because a leads feed is not something a user steers
 *  per-run. */
export const requestIntelligenceResearchSchema = z.object({});
export type RequestIntelligenceResearchInput = z.infer<typeof requestIntelligenceResearchSchema>;

export const updateIntelligenceItemStatusSchema = z.object({
  status: z.enum(['read', 'saved', 'dismissed']),
});
export type UpdateIntelligenceItemStatusInput = z.infer<
  typeof updateIntelligenceItemStatusSchema
>;

// Trend opportunity status/action types (the "Work On This" / "Save" /
// "Ignore" vocabulary) now live in trends.ts, next to TrendOpportunity
// itself — see trendOpportunityStatusSchema and
// updateTrendOpportunityStatusSchema there.

// ---------------------------------------------------------------------------
// AI Research prompt box
// ---------------------------------------------------------------------------

export const askBrandResearchSchema = z.object({
  question: z.string().min(1).max(500),
});
export type AskBrandResearchInput = z.infer<typeof askBrandResearchSchema>;

export const aiResearchQuerySchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  question: z.string(),
  answer: z.string(),
  sources: z.array(trendSourceSchema),
  createdAt: z.coerce.date(),
});
export type AiResearchQuery = z.infer<typeof aiResearchQuerySchema>;
