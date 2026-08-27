import { z } from 'zod';
import { entityIdSchema } from '../common.js';

/**
 * What a caller submits to generate a video.
 *
 * Deliberately not `creativeRequestSchema` with a `mediaType` flag: video has
 * none of the image request's vocabulary (`campaignType`, `styleTemplate`,
 * `outputFormat`, legible on-image text) and forcing it through that shape
 * would mean every video request carrying fields that mean nothing to it.
 *
 * `productId` is optional, unlike the image request's required one — a video
 * needs no product to condition on; text-to-video is a complete request on
 * its own, and a product's primary photo becomes the first frame only when
 * one is given.
 */
export const videoGenerationRequestSchema = z.object({
  brandId: entityIdSchema,
  /** When set, the product's primary photo becomes the video's first frame
   *  (LTX's `image_uri`) — the video animates from an actual product shot
   *  instead of one the model invents. */
  productId: entityIdSchema.optional(),
  prompt: z.string().min(1).max(1000),
  /** LTX's own ceiling. Defaults to 6s — long enough to read as a clip
   *  rather than a stinger, short enough to stay cheap while this is new. */
  durationSeconds: z.number().int().min(1).max(20).default(6),
  /** Defaults to a vertical Reel/Story frame — the dominant shape for short
   *  marketing video, and the one dimension pair this product already has an
   *  established meaning for (`OUTPUT_FORMAT_DIMENSIONS.story_reel_cover`). */
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
