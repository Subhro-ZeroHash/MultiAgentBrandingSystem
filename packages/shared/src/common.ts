import { z } from 'zod';

/**
 * Entity ids.
 *
 * Deliberately not `z.string().uuid()`: the id columns are Postgres `text`,
 * defaulted to a UUID for rows we create but able to hold ids minted elsewhere
 * — an auth provider's user id, or a readable id in a seed/fixture. Pinning the
 * contract to UUID format would reject valid rows the database happily stores.
 */
export const entityIdSchema = z.string().min(1).max(64);

/** Every async pipeline in both systems reports progress through this shape. */
export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobProgressSchema = z.object({
  jobId: entityIdSchema,
  status: jobStatusSchema,
  /** Pipeline stage name, e.g. "brief" | "image" | "qa" | "copy". */
  stage: z.string().optional(),
  /** 0-100. Coarse; the UI shows stage names, not a precise bar. */
  percent: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  updatedAt: z.coerce.date(),
});
export type JobProgress = z.infer<typeof jobProgressSchema>;

/**
 * Builds a PATCH schema from an entity schema.
 *
 * Use this instead of a plain `.partial()` on anything whose fields carry
 * `.default()`. Zod keeps the default through `.partial()`, so an absent key is
 * not absent by the time it reaches a service — it arrives as the default. Every
 * update service in both systems is written as
 *
 *     ...(input.bannedTopics ? { bannedTopics: input.bannedTopics } : {})
 *
 * which cannot tell "the client omitted this" from "the client sent []", and so
 * writes the default over whatever was stored. Renaming a brand emptied its
 * banned topics, tone, languages and platforms this way — silently, because
 * every value involved is valid.
 *
 * Stripping the defaults first restores the distinction: an omitted key stays
 * `undefined`, and only an explicit `[]` clears the column.
 *
 * The inferred type is unchanged — `ZodOptional<ZodDefault<T>>` and
 * `ZodOptional<T>` both infer `T | undefined` — so this is purely a runtime fix
 * and call sites keep their types.
 */
export function partialForUpdate<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): ReturnType<z.ZodObject<Shape>['partial']> {
  const stripped = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, stripDefaults(field as z.ZodTypeAny)]),
  ) as unknown as Shape;
  return z.object(stripped).partial() as ReturnType<z.ZodObject<Shape>['partial']>;
}

/**
 * Removes `.default()` wherever it sits in a field's wrapper chain.
 *
 * Recursive rather than a single `instanceof ZodDefault` check, because a
 * default is routinely already wrapped by the time an update schema is derived:
 * `createBrandKitSchema` marks its optional fields with `.partial({...})`, which
 * produces `ZodOptional<ZodDefault<T>>`. A top-level check sees the
 * `ZodOptional`, finds no default, and leaves the whole problem in place — which
 * is exactly how the first attempt at this fix passed review and changed
 * nothing for four of the five affected columns.
 */
// The casts are zod v4's unwrappers reporting the looser `$ZodType`; the runtime
// values are ordinary schemas, and the wrapper is rebuilt below either way.
function stripDefaults(field: z.ZodTypeAny): z.ZodTypeAny {
  if (field instanceof z.ZodDefault) return stripDefaults(field.removeDefault() as z.ZodTypeAny);
  if (field instanceof z.ZodOptional) {
    return stripDefaults(field.unwrap() as z.ZodTypeAny).optional();
  }
  if (field instanceof z.ZodNullable) {
    return stripDefaults(field.unwrap() as z.ZodTypeAny).nullable();
  }
  return field;
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Per-call cost telemetry. Mandatory from day one (PRD §9) — every provider
 * call, in either system, writes one of these.
 */
export const costEventSchema = z.object({
  provider: z.string(),
  model: z.string(),
  operation: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  imageCount: z.number().int().nonnegative().optional(),
  /** Micro-USD to avoid float drift in the ledger. */
  costMicroUsd: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type CostEvent = z.infer<typeof costEventSchema>;
