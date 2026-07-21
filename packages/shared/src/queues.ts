import { z } from 'zod';
import { entityIdSchema } from './common.js';

/**
 * Queue and job names are shared so an API can enqueue work a worker in a
 * different app consumes without either side hard-coding a string.
 */
// BullMQ rejects ':' in queue names (it namespaces its own Redis keys with it),
// and the same applies to custom job ids — use '-' as the separator.
export const QUEUES = {
  contentGeneration: 'content-generation',
  contentEdit: 'content-edit',
  geoProbe: 'geo-probe',
  geoRollup: 'geo-rollup',
  geoSweep: 'geo-sweep',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const contentGenerationJobSchema = z.object({
  jobId: entityIdSchema,
  brandId: entityIdSchema,
  idempotencyKey: z.string(),
});
export type ContentGenerationJob = z.infer<typeof contentGenerationJobSchema>;

export const contentEditJobSchema = z.object({
  assetId: entityIdSchema,
  instruction: z.string(),
});
export type ContentEditJob = z.infer<typeof contentEditJobSchema>;

/** One prompt against one engine. Fan-out happens at enqueue time so a single
 * slow engine can't hold up the rest of the sweep. */
export const geoProbeJobSchema = z.object({
  promptId: entityIdSchema,
  brandId: entityIdSchema,
  engine: z.string(),
});
export type GeoProbeJob = z.infer<typeof geoProbeJobSchema>;

export const geoRollupJobSchema = z.object({
  brandId: entityIdSchema,
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});
export type GeoRollupJob = z.infer<typeof geoRollupJobSchema>;

/**
 * What the cron schedulers fire. These are orchestration jobs, not work: the
 * sweep worker turns one of these into the fan-out of probe or roll-up jobs.
 * Keeping that indirection means a cron tick carries no per-brand payload, so
 * adding a prompt doesn't require rewriting a scheduler's job template.
 */
export const geoSweepJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), promptId: entityIdSchema }),
  z.object({ kind: z.literal('rollup') }),
]);
export type GeoSweepJob = z.infer<typeof geoSweepJobSchema>;
