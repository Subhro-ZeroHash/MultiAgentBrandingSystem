import { z } from 'zod';
import { entityIdSchema } from './common.js';

/**
 * The Brand Kit is the one entity both systems share: content generation reads
 * it to stay on-brand, GEO reads it to know what to track. Changes here need
 * both workstream owners' review.
 */

export const toneOfVoiceSchema = z.enum(['friendly', 'premium', 'playful', 'traditional']);
export type ToneOfVoice = z.infer<typeof toneOfVoiceSchema>;

export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex color like #1A2B3C');

export const brandKitSchema = z.object({
  id: entityIdSchema,
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().nullable(),
  colors: z.array(hexColorSchema).max(3),
  toneOfVoice: toneOfVoiceSchema,
  category: z.string().max(120).nullable(),
  audience: z.string().max(500).nullable(),
  websiteUrl: z.string().url().nullable(),
  /** Handles used by GEO to attribute mentions, and by copy gen for CTAs. */
  socialHandles: z.record(z.string(), z.string()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BrandKit = z.infer<typeof brandKitSchema>;

export const createBrandKitSchema = brandKitSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({
    logoUrl: true,
    category: true,
    audience: true,
    websiteUrl: true,
    socialHandles: true,
  });
export type CreateBrandKitInput = z.infer<typeof createBrandKitSchema>;

export const updateBrandKitSchema = createBrandKitSchema.partial();
export type UpdateBrandKitInput = z.infer<typeof updateBrandKitSchema>;
