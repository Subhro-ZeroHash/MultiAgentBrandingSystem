import { z } from 'zod';
import { entityIdSchema } from '../common.js';

export const AD_PLATFORMS = ['google', 'meta', 'x'] as const;
export const adPlatformSchema = z.enum(AD_PLATFORMS);
export type AdPlatform = z.infer<typeof adPlatformSchema>;

export const AD_CAMPAIGN_STATUSES = ['active', 'paused', 'completed'] as const;
export const adCampaignStatusSchema = z.enum(AD_CAMPAIGN_STATUSES);
export type AdCampaignStatus = z.infer<typeof adCampaignStatusSchema>;

export const AD_OPTIMIZATION_STATUSES = ['proposed', 'applied', 'dismissed'] as const;
export const adOptimizationStatusSchema = z.enum(AD_OPTIMIZATION_STATUSES);
export type AdOptimizationStatus = z.infer<typeof adOptimizationStatusSchema>;

export const AD_SUGGESTION_TYPES = [
  'budget_shift',
  'keyword_add',
  'creative_swap',
  'bid_adjustment',
] as const;
export const adSuggestionTypeSchema = z.enum(AD_SUGGESTION_TYPES);
export type AdSuggestionType = z.infer<typeof adSuggestionTypeSchema>;

export const adCampaignSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  platform: adPlatformSchema,
  campaignName: z.string().min(1).max(200),
  status: adCampaignStatusSchema,
  dailyBudget: z.number().nonnegative(),
  spendToDate: z.number().nonnegative(),
  roas: z.number().nonnegative(),
  keywords: z.array(z.string()),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
});
export type AdCampaignDto = z.infer<typeof adCampaignSchema>;

export const adOptimizationSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  campaignId: entityIdSchema.nullable(),
  campaignName: z.string().optional(),
  suggestionType: z.string(),
  reasoning: z.string(),
  status: adOptimizationStatusSchema,
  actionPayload: z.record(z.string(), z.unknown()).nullable().optional(),
  impactEstimate: z.string().nullable().optional(),
  createdAt: z.string().or(z.date()),
  appliedAt: z.string().or(z.date()).nullable().optional(),
});
export type AdOptimizationDto = z.infer<typeof adOptimizationSchema>;

export const triggerAdOptimizationSchema = z.object({
  brandId: entityIdSchema,
});
export type TriggerAdOptimizationInput = z.infer<typeof triggerAdOptimizationSchema>;
