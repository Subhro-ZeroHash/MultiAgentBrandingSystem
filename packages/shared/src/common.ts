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
