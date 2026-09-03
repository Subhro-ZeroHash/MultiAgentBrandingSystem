import { z } from 'zod';
import { campaignTypeSchema, styleTemplateSchema } from './creative.js';
import { entityIdSchema } from '../common.js';

/**
 * What a caller submits to generate a video.
 *
 * Deliberately the same structured vocabulary `creativeRequestSchema` uses —
 * `campaignType`, `styleTemplate`, `headlineText`/`offerText`/`ctaText`,
 * `extraInstructions` — rather than a raw prompt the client writes itself.
 * The app never shows a "describe your video" box: a video is what a Story/
 * Reel selection on the same product-and-style form the image path already
 * uses produces, so the worker needs the same structured intake to compose a
 * real brief from (see `composeVideoBrief` in generate-video.ts, the video
 * counterpart of `composeBrief`). `outputFormat` itself isn't part of it —
 * every video is Reel-shaped by construction, there is no second format to
 * choose between the way images have four.
 *
 * `productId` is required, unlike an early version of this schema: a video
 * always comes from the same "create a product, then generate" flow images
 * do now, so there is always one to condition on and to read
 * name/description/sellingPoints from.
 */
export const videoGenerationRequestSchema = z.object({
  brandId: entityIdSchema,
  productId: entityIdSchema,
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  headlineText: z.string().max(80).optional(),
  offerText: z.string().max(40).optional(),
  ctaText: z.string().max(40).optional(),
  /** FR-2.4-equivalent escape hatch, same role it plays for images. */
  extraInstructions: z.string().max(500).optional(),
  /** LTX's own ceiling is 20s. Defaults to 10s — long enough for the end
   *  card to hold its message without eating most of the clip. Falls back to
   *  Veo's fixed 8s option (see `nearestVeoDuration`) when LTX is
   *  unavailable, since Veo has no 10s tier of its own. */
  durationSeconds: z.number().int().min(1).max(20).default(10),
  /** A vertical Reel/Story frame — the one shape a video from this pipeline
   *  is ever asked for, matching `OUTPUT_FORMAT_DIMENSIONS.story_reel_cover`. */
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
});
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;

export const videoAssetSchema = z.object({
  id: entityIdSchema,
  url: z.string().url(),
  thumbnailUrl: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  provider: z.string(),
  model: z.string(),
});
export type VideoAsset = z.infer<typeof videoAssetSchema>;
