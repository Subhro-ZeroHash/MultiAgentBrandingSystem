import { z } from 'zod';
import { entityIdSchema } from '../common.js';

/** FR-2.2: presets carry real pixel dimensions, not just a ratio label. */
export const outputFormatSchema = z.enum([
  'instagram_post', // 1080 x 1080
  'story_reel_cover', // 1080 x 1920
  'facebook_banner', // 1200 x 628
  'poster_a4', // 2480 x 3508 @ 300dpi
]);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const OUTPUT_FORMAT_DIMENSIONS: Record<
  OutputFormat,
  { width: number; height: number; printIntent: boolean }
> = {
  instagram_post: { width: 1080, height: 1080, printIntent: false },
  story_reel_cover: { width: 1080, height: 1920, printIntent: false },
  facebook_banner: { width: 1200, height: 628, printIntent: false },
  poster_a4: { width: 2480, height: 3508, printIntent: true },
};

export const campaignTypeSchema = z.enum(['offer', 'launch', 'festival', 'generic']);
export type CampaignType = z.infer<typeof campaignTypeSchema>;

/**
 * FR-2.3: the user picks a look; the system composes the prompt.
 *
 * The original four all assumed apparel retail, which left anything else — a
 * gadget, a meal, a service — with no honest fit and pushed users onto
 * `festive` by default. The list is deliberately broader than one vertical:
 * the first group suits any product, the second leans to a category.
 *
 * Adding a value here is a contract change. `STYLE_DIRECTION` in the worker's
 * stages.ts is a total Record over this type, so the build fails until the art
 * direction exists — that is intentional, an unmapped style would otherwise
 * reach the model as an empty instruction.
 */
export const styleTemplateSchema = z.enum([
  // Work for any product category.
  'festive',
  'minimal_luxury',
  'bold_discount',
  'flat_lay_product_hero',
  'studio_white',
  'lifestyle_in_use',
  'bold_typographic',
  // Lean towards a category, but not restricted to one.
  'tech_dark_gradient',
  'neon_gaming',
  'outdoor_natural_light',
  'vintage_retro',
  'playful_pastel',
]);
export type StyleTemplate = z.infer<typeof styleTemplateSchema>;

export const platformSchema = z.enum(['instagram', 'facebook', 'whatsapp']);
export type Platform = z.infer<typeof platformSchema>;

/** FR-2.1: structured intake — deliberately not a freeform prompt box. */
export const creativeRequestSchema = z.object({
  brandId: entityIdSchema,
  productId: entityIdSchema,
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  outputFormat: outputFormatSchema,
  /** Text that must render legibly on the image: offer %, price, tagline. */
  headlineText: z.string().max(80).optional(),
  offerText: z.string().max(40).optional(),
  ctaText: z.string().max(40).optional(),
  /** FR-2.4: escape hatch, not the primary path. */
  extraInstructions: z.string().max(500).optional(),
  variantCount: z.number().int().min(1).max(4).default(3),
  /**
   * 'diverse': each variant draws on a different knowledge source (current
   * trends, the brand's website, or the client's brief alone) — the manual
   * Create screen's mode. 'uniform': today's original behaviour, one shared
   * prompt fanned out to `variantCount` images — what scheduled/auto-campaign
   * generations use. An explicit field rather than inferring from
   * `variantCount === 3`, so the trigger for 'diverse' isn't a magic number.
   */
  variantMode: z.enum(['diverse', 'uniform']).default('uniform'),
  language: z.string().default('en'),
});
export type CreativeRequest = z.infer<typeof creativeRequestSchema>;

export const creativeVariantSchema = z.object({
  id: entityIdSchema,
  url: z.string().url(),
  thumbnailUrl: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provider: z.string(),
  model: z.string(),
  /** FR-3.5 vision QA readback. Null until the QA stage has run. */
  qa: z
    .object({
      textLegible: z.boolean(),
      detectedText: z.string(),
      spellingOk: z.boolean(),
      notes: z.string().optional(),
    })
    .nullable()
    .default(null),
});
export type CreativeVariant = z.infer<typeof creativeVariantSchema>;

/** FR-3.3: targeted edit of one asset, not a full regeneration. `assetId`
 *  travels alongside the same id in the request URL (`POST
 *  /generations/:jobId/assets/:assetId/regenerate`); named to match it. */
export const creativeEditRequestSchema = z.object({
  assetId: entityIdSchema,
  instruction: z.string().min(1).max(300),
});
export type CreativeEditRequest = z.infer<typeof creativeEditRequestSchema>;
