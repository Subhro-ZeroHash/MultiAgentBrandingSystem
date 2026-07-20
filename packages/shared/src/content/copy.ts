import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { platformSchema } from './creative.js';

/** FR-4.1: one copy pack is produced alongside every image. */
export const copyPackSchema = z.object({
  headline: z.string().max(120),
  caption: z.string().max(2200),
  hashtags: z.array(z.string()).min(8).max(15),
  cta: z.string().max(80),
  platform: platformSchema,
  language: z.string().default('en'),
});
export type CopyPack = z.infer<typeof copyPackSchema>;

export const copyRequestSchema = z.object({
  brandId: entityIdSchema,
  productId: entityIdSchema,
  platforms: z.array(platformSchema).min(1).default(['instagram']),
  language: z.string().default('en'),
  offerText: z.string().max(40).optional(),
});
export type CopyRequest = z.infer<typeof copyRequestSchema>;
