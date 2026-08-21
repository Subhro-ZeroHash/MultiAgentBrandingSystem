import { z } from 'zod';
import { entityIdSchema } from './common.js';
import { categoryKeySchema } from './content/category.js';
import { poolRunScopeSchema } from './content/research-pool.js';

/**
 * Queue and job names are shared so an API can enqueue work a worker in a
 * different app consumes without either side hard-coding a string.
 */
// BullMQ rejects ':' in queue names (it namespaces its own Redis keys with it),
// and the same applies to custom job ids — use '-' as the separator.
export const QUEUES = {
  contentGeneration: 'content-generation',
  contentEdit: 'content-edit',
  scheduledPostPublish: 'scheduled-post-publish',
  trendResearch: 'trend-research',
  intelligenceResearch: 'intelligence-research',
  /** The autonomous scheduler's own tick, not a per-brand job. One repeatable
   *  BullMQ job with a fixed id ('scheduler-tick') fires every
   *  RESEARCH_SCHEDULER_INTERVAL_HOURS and fans out real work — enqueuing
   *  trend-research and intelligence-research jobs for whichever brands
   *  automation_settings says are due. */
  researchScheduler: 'research-scheduler',
  /** Layer A — one search+synthesis pass per category/national bucket,
   *  shared by every brand in scope. See research-pool.ts. */
  trendPoolResearch: 'trend-pool-research',
  intelligencePoolResearch: 'intelligence-pool-research',
  /** The pool's own periodic tick, same shape as `researchScheduler` but
   *  refreshing pool buckets instead of enqueuing per-brand runs. */
  poolScheduler: 'pool-scheduler',
  geoProbe: 'geo-probe',
  geoRollup: 'geo-rollup',
  geoSweep: 'geo-sweep',
  /** The periodic tick that sweeps recently-published posts for fresh
   *  Instagram metrics. Same shape as researchScheduler: one repeatable job,
   *  empty payload, re-reads what's due every time it fires. */
  instagramInsightsSync: 'instagram-insights-sync',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const contentGenerationJobSchema = z.object({
  jobId: entityIdSchema,
  brandId: entityIdSchema,
  idempotencyKey: z.string(),
});
export type ContentGenerationJob = z.infer<typeof contentGenerationJobSchema>;

/** Thin and id-only like every other job schema here — the worker re-reads
 *  the `asset_edits` row's current state rather than trusting a payload that
 *  could go stale sitting in the queue. */
export const contentEditJobSchema = z.object({
  editId: entityIdSchema,
});
export type ContentEditJob = z.infer<typeof contentEditJobSchema>;

/** Fired at a scheduled post's publish time. The processor re-reads the row's
 *  current status rather than trusting anything captured at enqueue time — the
 *  user may not have approved it, or may have cancelled the whole campaign. */
export const scheduledPostPublishJobSchema = z.object({
  scheduledPostId: entityIdSchema,
});
export type ScheduledPostPublishJob = z.infer<typeof scheduledPostPublishJobSchema>;

export const trendResearchJobSchema = z.object({
  runId: entityIdSchema,
  brandId: entityIdSchema,
});
export type TrendResearchJob = z.infer<typeof trendResearchJobSchema>;

export const intelligenceResearchJobSchema = z.object({
  runId: entityIdSchema,
  brandId: entityIdSchema,
});
export type IntelligenceResearchJob = z.infer<typeof intelligenceResearchJobSchema>;

/** How often the scheduler wakes up to check `automation_settings` for brands
 *  that are due. Not the same clock as a brand's own cadence (daily / three
 *  days / weekly, see TrendFrequency) — this is just how granular "due" gets
 *  checked. A brand due for weekly research does not need a minute-accurate
 *  trigger; ten hours keeps the miss window small without a job waking up and
 *  finding nothing to do almost every time it runs. */
export const RESEARCH_SCHEDULER_INTERVAL_HOURS = 10;

/** Empty payload — the tick itself carries no state, it just re-reads
 *  `automation_settings` fresh every time it fires. */
export const researchSchedulerTickJobSchema = z.object({});
export type ResearchSchedulerTickJob = z.infer<typeof researchSchedulerTickJobSchema>;

/** One Layer A refresh: a single search+synthesis pass for one pool bucket
 *  (one category, or the national bucket when `category` is null). Thin and
 *  id-plus-bucket like every other job schema here — the worker re-reads the
 *  `pool_*_runs` row's current state rather than trusting a payload that
 *  could go stale sitting in the queue. */
export const poolRefreshJobSchema = z.object({
  runId: entityIdSchema,
  scope: poolRunScopeSchema,
  category: categoryKeySchema.nullable(),
});
export type PoolRefreshJob = z.infer<typeof poolRefreshJobSchema>;

/** How often the pool scheduler wakes up to check every bucket's freshness.
 *  Finer-grained than `RESEARCH_SCHEDULER_INTERVAL_HOURS` for the same reason
 *  `POOL_CADENCE_HOURS` (@bmas/shared/content/research-pool.ts) is shorter
 *  than a brand's old per-brand cadence: a pool refresh is now shared and
 *  cheap relative to before, so there is no reason to check rarely. */
export const POOL_SCHEDULER_INTERVAL_HOURS = 6;

/** Empty payload, same reasoning as `researchSchedulerTickJobSchema` — the
 *  tick re-reads the latest run per bucket fresh every time it fires. */
export const poolSchedulerTickJobSchema = z.object({});
export type PoolSchedulerTickJob = z.infer<typeof poolSchedulerTickJobSchema>;

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

/** How often the sync sweeps for fresh Instagram metrics. Engagement numbers
 *  don't need minute-level freshness, and this keeps Graph API usage light —
 *  four sweeps a day is enough to see a post's engagement curve without
 *  hammering the API every time it fires. */
export const INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS = 6;

/** How far back a post stays in scope for a sync sweep. Engagement on an
 *  older post has effectively plateaued, so there is little value in an
 *  unbounded sweep that only grows more expensive as posts accumulate. */
export const INSTAGRAM_INSIGHTS_LOOKBACK_DAYS = 30;

/** Empty payload, same reasoning as researchSchedulerTickJobSchema — the tick
 *  re-reads which posts are due fresh every time it fires. */
export const instagramInsightsSyncTickJobSchema = z.object({});
export type InstagramInsightsSyncTickJob = z.infer<typeof instagramInsightsSyncTickJobSchema>;
