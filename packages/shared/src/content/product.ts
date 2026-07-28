import { z } from 'zod';
import { entityIdSchema } from '../common.js';

export const productImageSchema = z.object({
  id: entityIdSchema,
  url: z.string().url(),
  /** Background-removed / cleaned variant, when the prep step has run. */
  cleanedUrl: z.string().url().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  isPrimary: z.boolean().default(false),
});
export type ProductImage = z.infer<typeof productImageSchema>;

export const productSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  priceMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).default('INR'),
  /** Short, concrete claims ("Pure silk", "Handwoven") the brief and copy
   *  stages can lean on directly instead of inferring them from `description`. */
  sellingPoints: z.array(z.string().min(1).max(120)).max(10).default([]),
  images: z.array(productImageSchema).max(5),
  createdAt: z.coerce.date(),
});
export type Product = z.infer<typeof productSchema>;

export const createProductSchema = productSchema
  .omit({ id: true, images: true, createdAt: true })
  .partial({ description: true, priceMinor: true, currency: true, sellingPoints: true });
export type CreateProductInput = z.infer<typeof createProductSchema>;
