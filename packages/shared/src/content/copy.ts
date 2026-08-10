import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { platformSchema } from './creative.js';

/** FR-4.1: one copy pack is produced alongside every image. */
export const copyPackSchema = z.object({
  headline: z.string().max(120),
  caption: z.string().max(2200),
  // min/max are what `z.toJSONSchema` turns into minItems/maxItems, which is
  // what actually makes a model return a full set. Keep this schema free of
  // transforms: toJSONSchema throws on them, and the content pipeline derives
  // the model's response schema from exactly this object. Clean the result
  // with `normaliseHashtags` after parsing instead.
  hashtags: z.array(z.string()).min(8).max(15),
  cta: z.string().max(80),
  platform: platformSchema,
  language: z.string().default('en'),
});
export type CopyPack = z.infer<typeof copyPackSchema>;

/**
 * A hashtag ends at its first whitespace on every platform we publish to, so
 * anything after that is not part of the tag. Generators do emit trailing
 * noise — "#NirvantaSilks me", "#BanarasiSilk stroke!" — and `z.string()`
 * happily accepts it, so tags are cut back here before they reach a caption.
 *
 * May return fewer than the 8 the schema asks for, once duplicates and
 * unsalvageable tags are gone. That is deliberate: a short list beats failing
 * a whole generation over a cosmetic defect in one tag.
 */
export function normaliseHashtags(tags: string[]): string[] {
  const cleaned = tags.map((raw) => {
    const [first = ''] = raw.trim().split(/\s+/);
    // Letters/digits/underscore are all that survives a tag on Instagram.
    // \p{M} is not optional here: Indic vowel signs are combining marks, so
    // dropping them silently rewrites the word — #साड़ी became #सड without it.
    const body = first.replace(/^#+/, '').replace(/[^\p{L}\p{N}\p{M}_]/gu, '');
    return body ? `#${body}` : '';
  });

  return [...new Set(cleaned.filter(Boolean))];
}

export const copyRequestSchema = z.object({
  brandId: entityIdSchema,
  productId: entityIdSchema,
  platforms: z.array(platformSchema).min(1).default(['instagram']),
  language: z.string().default('en'),
  offerText: z.string().max(40).optional(),
});
export type CopyRequest = z.infer<typeof copyRequestSchema>;
