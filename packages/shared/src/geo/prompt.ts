import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { answerEngineSchema } from './engine.js';

/**
 * A tracked prompt is the unit of measurement: a question a real buyer would
 * ask an assistant, which we re-ask on a schedule to see whether the brand
 * shows up in the answer.
 */

export const promptIntentSchema = z.enum([
  'discovery', // "best saree boutiques in Jaipur"
  'comparison', // "X vs Y for wedding wear"
  'brand_direct', // "is <brand> any good"
  'transactional', // "where can I buy <product> online"
  'informational', // "how do I care for a silk saree"
]);
export type PromptIntent = z.infer<typeof promptIntentSchema>;

/**
 * Who put the prompt on the list. `suggested` rows come from the generator and
 * a refresh replaces them; `user` rows were typed by a person and no automated
 * path ever removes them.
 */
export const trackedPromptSourceSchema = z.enum(['suggested', 'user']);
export type TrackedPromptSource = z.infer<typeof trackedPromptSourceSchema>;

export const trackedPromptSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  text: z.string().min(3).max(500),
  intent: promptIntentSchema,
  /** ISO-3166-1 alpha-2 country, or a city string for local-intent prompts. */
  locale: z.string().max(64).nullable(),
  engines: z.array(answerEngineSchema).min(1),
  /** Cron expression for the probe cadence. Defaults to weekly. */
  schedule: z.string().default('0 6 * * 1'),
  source: trackedPromptSourceSchema.default('user'),
  isActive: z.boolean().default(true),
  createdAt: z.coerce.date(),
});
export type TrackedPrompt = z.infer<typeof trackedPromptSchema>;

// `source` is omitted, not partial: a prompt created through the API is by
// definition one a person added, so letting a caller claim 'suggested' would
// only create a row the refresh path could silently delete.
export const createTrackedPromptSchema = trackedPromptSchema
  .omit({ id: true, createdAt: true, source: true })
  .partial({ locale: true, schedule: true, isActive: true });
export type CreateTrackedPromptInput = z.infer<typeof createTrackedPromptSchema>;

/** A competitor we score the brand against on the same prompt set. */
export const competitorSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  name: z.string().min(1).max(120),
  domain: z.string().max(255).nullable(),
  /** Extra strings that count as a mention of this competitor. */
  aliases: z.array(z.string()).default([]),
});
export type Competitor = z.infer<typeof competitorSchema>;
