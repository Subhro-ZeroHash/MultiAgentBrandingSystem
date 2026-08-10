import { z } from 'zod';
import { entityIdSchema, partialForUpdate } from './common.js';

/**
 * The Brand Kit is the one entity both systems share: content generation reads
 * it to stay on-brand, GEO reads it to know what to track. Changes here need
 * both workstream owners' review.
 */

export const toneOfVoiceSchema = z.enum([
  'friendly',
  'premium',
  'playful',
  'traditional',
  'elegant',
]);
export type ToneOfVoice = z.infer<typeof toneOfVoiceSchema>;

export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex color like #1A2B3C');

export const brandKitSchema = z.object({
  id: entityIdSchema,
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().nullable(),
  colors: z.array(hexColorSchema).max(3),
  /** A brand can hold more than one register at once, e.g. ['elegant',
   *  'traditional', 'premium'] — generation blends them rather than picking one. */
  tone: z.array(toneOfVoiceSchema).min(1).max(3).default(['friendly']),
  category: z.string().max(120).nullable(),
  audience: z.string().max(500).nullable(),
  /** City/region the business trades from, e.g. "Jaipur". */
  location: z.string().max(120).nullable(),
  /** First is the default when a generation request does not specify one. */
  languages: z.array(z.string().min(1).max(40)).max(10).default([]),
  /** Informational: which platforms the brand is active on. A generation
   *  request's own `outputFormat` still decides that run's copy platform. */
  platforms: z.array(z.string().min(1).max(40)).max(10).default([]),
  /** Subjects generation must never reference for this brand. */
  bannedTopics: z.array(z.string().min(1).max(200)).max(20).default([]),
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
    location: true,
    languages: true,
    platforms: true,
    bannedTopics: true,
    websiteUrl: true,
    socialHandles: true,
  });
export type CreateBrandKitInput = z.infer<typeof createBrandKitSchema>;

/** Defaults stripped, not merely made optional — see `partialForUpdate`. A
 *  plain `.partial()` here let a rename empty the brand's banned topics. */
export const updateBrandKitSchema = partialForUpdate(createBrandKitSchema);
export type UpdateBrandKitInput = z.infer<typeof updateBrandKitSchema>;
