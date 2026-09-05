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
export const videoModeSchema = z.enum(['cinematic_broll', 'advertisement']);
export type VideoMode = z.infer<typeof videoModeSchema>;

export const videoGenerationRequestSchema = z.object({
  brandId: entityIdSchema,
  productId: entityIdSchema,
  campaignType: campaignTypeSchema,
  styleTemplate: styleTemplateSchema,
  /** Picks both the provider and how the result is finished — not a quality
   *  tier, two different products. `cinematic_broll` renders on LTX and ships
   *  exactly what LTX returned, untouched: raw supplementary footage, no
   *  burnt-in text. `advertisement` renders on Gemini's Veo models and gets
   *  the closing headline/CTA burned onto the last seconds the way an ad
   *  needs one. Each mode is pinned to its own provider — see
   *  `PROVIDER_FOR_MODE` in generate-video.ts — there is no fallback between
   *  them, so a Veo outage doesn't silently hand back LTX footage under an
   *  "advertisement" label or vice versa. */
  videoMode: videoModeSchema.default('cinematic_broll'),
  headlineText: z.string().max(80).optional(),
  offerText: z.string().max(40).optional(),
  ctaText: z.string().max(40).optional(),
  /** FR-2.4-equivalent escape hatch, same role it plays for images. */
  extraInstructions: z.string().max(500).optional(),
  /** Every video this pipeline makes is at least 10s. LTX renders this exactly
   *  (its own ceiling is 20s). Veo has no 10s tier at all — the closest it has
   *  is 8s — so an `advertisement` request is accepted here and then snapped
   *  down to its nearest option (8s) by `nearestVeoDuration` in
   *  gemini.video.ts; that's an accepted provider ceiling, not a bug, and the
   *  one case where the finished video is shorter than requested. */
  durationSeconds: z.number().int().min(10).max(20).default(10),
  /** The one shape a video from this pipeline is ever asked for, matching
   *  `OUTPUT_FORMAT_DIMENSIONS.story_reel_cover` — fixed rather than just
   *  defaulted, since nothing in the app ever asks for another size. */
  width: z.literal(1080).default(1080),
  height: z.literal(1920).default(1920),
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
