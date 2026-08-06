import { z } from 'zod';
import {
  trendCategorySchema,
  trendContentTypeSchema,
  trendSourceSchema,
  trendSuggestedRequestSchema,
} from './trends.js';
import { intelligenceUrgencySchema } from './intelligence.js';
import { categoryKeySchema } from './category.js';

/**
 * Layer A — the Global Research Pool.
 *
 * Trend Research and Intelligence Research used to run their full
 * search-and-synthesize pipeline once per brand, per click — cheap at one
 * brand, but N brands in the same industry pay for and repeat nearly
 * identical searches (a festival calendar, an industry news cycle) N times
 * over. Most of what those searches surface is not actually brand-specific;
 * only its *relevance* is.
 *
 * The pool splits that in two:
 *   - Layer A (this file's schemas) runs the real search + synthesis once per
 *     category (or once nationally for things that aren't industry-qualified
 *     at all, e.g. festival dates), on a fixed schedule independent of how
 *     many brands exist.
 *   - Layer B (`trendRelevance*`/`intelligenceRelevance*` below) is what a
 *     brand's own research run does instead: load the pool for its category,
 *     and run one cheap LLM call scoring each pool item's relevance to *this*
 *     brand specifically — no fresh web search.
 *
 * See packages/db/src/schema/research-pool.ts for the tables these back, and
 * `apps/content-worker/src/pipeline/{trend,intelligence}-pool-refresh.ts` for
 * the Layer A pipelines that produce them.
 */

export const poolRunScopeSchema = z.enum(['category', 'national']);
export type PoolRunScope = z.infer<typeof poolRunScopeSchema>;

export const poolRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type PoolRunStatus = z.infer<typeof poolRunStatusSchema>;

// ---------------------------------------------------------------------------
// Trend pool
// ---------------------------------------------------------------------------

/** Brand-agnostic axes only — `brandRelevance`/`audienceRelevance` don't
 *  exist yet at this layer, since no brand is in the picture. Layer B adds
 *  those once it scores a pool item against one specific brand. */
export const trendPoolScoreSchema = z.object({
  popularity: z.number().min(0).max(100),
  freshness: z.number().min(0).max(100),
  marketingPotential: z.number().min(0).max(100),
});
export type TrendPoolScore = z.infer<typeof trendPoolScoreSchema>;

/** What the Layer A trend synthesis call produces for one cluster — the pool
 *  counterpart of `trendOpportunityDraftSchema`, minus the two brand-judged
 *  axes and the signal-index list (the pool refresh resolves signals the same
 *  way trend-research.ts's `resolveOpportunitySignals` does, just not against
 *  one brand's context). */
export const trendPoolItemDraftSchema = z.object({
  signalIndexes: z.array(z.number().int().min(0)).min(1),
  topic: z.string().min(1).max(160),
  category: trendCategorySchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(600),
  /** A generic recommendation, not yet brand-specific — Layer B may override
   *  this per brand via `trendRelevanceDraftSchema.recommendationOverride`. */
  recommendation: z.string().min(1).max(400),
  contentType: trendContentTypeSchema,
  score: trendPoolScoreSchema,
  suggestedRequest: trendSuggestedRequestSchema,
});
export type TrendPoolItemDraft = z.infer<typeof trendPoolItemDraftSchema>;

export const trendPoolSynthesisSchema = z.object({
  items: z.array(trendPoolItemDraftSchema).max(15),
});
export type TrendPoolSynthesis = z.infer<typeof trendPoolSynthesisSchema>;

// ---------------------------------------------------------------------------
// Intelligence pool
// ---------------------------------------------------------------------------

/** `businessImpact`/`recency` only — `brandRelevance`/`industryRelevance`/
 *  `geographicRelevance` are Layer B's job. `geographicRelevance` in
 *  particular needs the brand's actual trading city, which a national/
 *  category-scoped pool item deliberately does not have. */
export const intelligencePoolScoreSchema = z.object({
  businessImpact: z.number().min(0).max(100),
  recency: z.number().min(0).max(100),
});
export type IntelligencePoolScore = z.infer<typeof intelligencePoolScoreSchema>;

/** Only the poolable subset of `intelligenceCategorySchema` — `competitor`
 *  (named competitors differ per brand) and `brand_news` are never pooled. */
export const poolableIntelligenceCategorySchema = z.enum([
  'government_policy',
  'industry_news',
  'local',
]);
export type PoolableIntelligenceCategory = z.infer<typeof poolableIntelligenceCategorySchema>;

export const intelligencePoolItemDraftSchema = z.object({
  category: poolableIntelligenceCategorySchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(600),
  urgency: intelligenceUrgencySchema,
  score: intelligencePoolScoreSchema,
  sources: z.array(trendSourceSchema).max(5),
});
export type IntelligencePoolItemDraft = z.infer<typeof intelligencePoolItemDraftSchema>;

export const intelligencePoolSynthesisSchema = z.object({
  items: z.array(intelligencePoolItemDraftSchema).max(15),
});
export type IntelligencePoolSynthesis = z.infer<typeof intelligencePoolSynthesisSchema>;

// ---------------------------------------------------------------------------
// Layer B — brand relevance scoring against the pool
// ---------------------------------------------------------------------------

/** What the cheap Layer B relevance call adds per pool item it selects for
 *  one brand. No raw signals, no re-derived summary/recommendation in the
 *  prompt — just the two brand-judged axes `trendModelScoreSchema` carries
 *  that the pool item itself cannot supply.
 *
 *  References the pool item by its position in the numbered list the prompt
 *  gave it (`poolItemIndex`), not by its database id — the same
 *  `signalIndexes` pattern `trendOpportunityDraftSchema` already uses, and
 *  for the same reason: a small model asked to echo back a long UUID
 *  verbatim is far more error-prone than one asked for a small integer it
 *  can see printed right next to each item. The caller resolves the index
 *  against the actual pool item list and drops anything out of bounds. */
export const trendRelevanceDraftSchema = z.object({
  poolItemIndex: z.number().int().min(0),
  brandRelevance: z.number().min(0).max(100),
  audienceRelevance: z.number().min(0).max(100),
  /** Index into the numbered product list the prompt was given — same
   *  index-not-id reasoning as `poolItemIndex`. Null when no product in the
   *  brand's catalog genuinely fits this opportunity; that's a legitimate
   *  outcome (`productRelevance` should be low in that case, not padded to
   *  look higher because a product was forced onto it). */
  productIndex: z.number().int().min(0).nullable(),
  productRelevance: z.number().min(0).max(100),
  /** How time-sensitive acting on this is for this brand specifically — see
   *  `trendModelScoreSchema.urgency`. */
  urgency: z.number().min(0).max(100),
  /** Null keeps the pool item's own generic recommendation verbatim; set only
   *  when this brand's angle genuinely differs from it. */
  recommendationOverride: z.string().min(1).max(400).nullable(),
});
export type TrendRelevanceDraft = z.infer<typeof trendRelevanceDraftSchema>;

export const trendRelevanceSynthesisSchema = z.object({
  items: z.array(trendRelevanceDraftSchema).max(8),
});
export type TrendRelevanceSynthesis = z.infer<typeof trendRelevanceSynthesisSchema>;

/** Same index-reference reasoning as `trendRelevanceDraftSchema` above. */
export const intelligenceRelevanceDraftSchema = z.object({
  poolItemIndex: z.number().int().min(0),
  brandRelevance: z.number().min(0).max(100),
  industryRelevance: z.number().min(0).max(100),
  geographicRelevance: z.number().min(0).max(100),
  /** The answer to "so what?" for this brand specifically — the pool item
   *  itself carries no brand angle at all. */
  whyItMatters: z.string().min(1).max(400),
});
export type IntelligenceRelevanceDraft = z.infer<typeof intelligenceRelevanceDraftSchema>;

export const intelligenceRelevanceSynthesisSchema = z.object({
  items: z.array(intelligenceRelevanceDraftSchema).max(10),
});
export type IntelligenceRelevanceSynthesis = z.infer<typeof intelligenceRelevanceSynthesisSchema>;

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/** How long a successful pool run's items count as fresh, per kind. Both
 *  agents' underlying material (industry news, festival calendars) does not
 *  meaningfully change within a day, and this is now shared across every
 *  brand in the bucket rather than paid per-brand — a much shorter cadence
 *  than a brand's old per-brand `trendFrequency` cost-rationing cadence would
 *  ever have been affordable at. */
export const POOL_CADENCE_HOURS = { trend: 24, intelligence: 24 } as const;

export function poolExpiresAt(kind: keyof typeof POOL_CADENCE_HOURS, finishedAt: Date): Date {
  return new Date(finishedAt.getTime() + POOL_CADENCE_HOURS[kind] * 3_600_000);
}

/** Every category bucket plus the one national bucket each kind needs
 *  (`event_festival` for trends, `local` for intelligence) — the fixed,
 *  enumerable set of buckets the pool scheduler refreshes. Exported so the
 *  scheduler and any future admin/debug view describe the same bucket list. */
export interface PoolBucket {
  scope: PoolRunScope;
  category: z.infer<typeof categoryKeySchema> | null;
}

export function allPoolBuckets(): PoolBucket[] {
  return [
    ...categoryKeySchema.options.map(
      (category): PoolBucket => ({ scope: 'category', category }),
    ),
    { scope: 'national', category: null },
  ];
}
