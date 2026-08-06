import { describeError } from '@bmas/ai';
import { and, desc, eq, isNotNull, isNull, schema } from '@bmas/db';
import {
  POOL_SCHEDULER_INTERVAL_HOURS,
  QUEUES,
  type CategoryKey,
  type PoolBucket,
  type PoolRunScope,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';
import { isUniqueViolation } from './pool-loader.js';

/**
 * The pool's own periodic scheduler — Layer A's counterpart to
 * `research-scheduler.ts`, refreshing pool buckets on a timer instead of
 * enqueuing per-brand runs.
 *
 * Demand-driven, not the full fixed taxonomy: a category with zero brands
 * classified into it is not a bucket anyone will ever read, so refreshing it
 * on a schedule would be spending real search/LLM calls on data nobody uses
 * — the exact waste this whole redesign exists to cut. Every tick re-derives
 * "which categories actually have a brand right now" from
 * `brand_contexts.category_key` (`loadActiveBuckets` below) rather than
 * iterating the full `CATEGORY_KEYS` enum. A brand-new category (a coffee
 * brand appearing when only perfume/travel/sports existed before) starts
 * getting refreshed on the very next tick after its first brand is
 * classified — no separate "register this category" step exists, or is
 * needed. The national bucket has no such gate: it backs every brand
 * regardless of category, so it's always included.
 *
 * This tick is a *convenience* refresh, not the only path a bucket gets
 * populated through — `ensureFreshPool` (pool-loader.ts) already refreshes a
 * bucket inline the moment any brand's own research run finds it stale, which
 * is what puts a brand-new category's bucket row in existence in the first
 * place (before that, `brand_contexts.category_key` for it doesn't exist
 * yet either, so this tick would have nothing to select). This tick exists
 * so an already-active bucket keeps getting refreshed proactively during the
 * quiet hours between requests, rather than only on next demand — the same
 * "set it and forget it" reasoning `research-scheduler.ts`'s own header
 * gives for existing at all.
 */

interface BucketRunStatus {
  status: (typeof schema.poolRunStatus.enumValues)[number];
  expiresAt: Date | null;
}

function bucketKey(scope: PoolRunScope, category: CategoryKey | null): string {
  return `${scope}:${category ?? ''}`;
}

/** Pure — which buckets need a fresh run right now, given the latest known
 *  run per bucket. Testable without touching Postgres, same split
 *  `nextResearchAt` gets in @bmas/shared. */
export function bucketsNeedingRefresh(
  buckets: PoolBucket[],
  latest: Map<string, BucketRunStatus>,
  now: Date,
): PoolBucket[] {
  return buckets.filter((bucket) => {
    const run = latest.get(bucketKey(bucket.scope, bucket.category));
    if (!run) return true; // never populated
    if (run.status === 'failed') return true; // retry
    if (run.status !== 'succeeded') return false; // queued/running — already in flight
    return !run.expiresAt || run.expiresAt <= now; // stale
  });
}

/** Every category with at least one brand actually classified into it,
 *  plus the always-on national bucket. Re-derived fresh every tick — see
 *  this file's header for why that's cheap and correct rather than
 *  iterating the full fixed taxonomy. */
async function loadActiveBuckets(ctx: WorkerContext): Promise<PoolBucket[]> {
  const rows = await ctx.db
    .selectDistinct({ categoryKey: schema.brandContexts.categoryKey })
    .from(schema.brandContexts)
    .where(isNotNull(schema.brandContexts.categoryKey));

  const categories = rows
    .map((row) => row.categoryKey)
    .filter((key): key is CategoryKey => key !== null);

  return [
    ...categories.map((category): PoolBucket => ({ scope: 'category', category })),
    { scope: 'national', category: null },
  ];
}

async function loadLatestTrendRuns(
  ctx: WorkerContext,
  buckets: PoolBucket[],
): Promise<Map<string, BucketRunStatus>> {
  const entries = await Promise.all(
    buckets.map(async (bucket) => {
      const [row] = await ctx.db
        .select({ status: schema.poolTrendRuns.status, expiresAt: schema.poolTrendRuns.expiresAt })
        .from(schema.poolTrendRuns)
        .where(
          and(
            eq(schema.poolTrendRuns.scope, bucket.scope),
            bucket.category === null
              ? isNull(schema.poolTrendRuns.category)
              : eq(schema.poolTrendRuns.category, bucket.category),
          ),
        )
        .orderBy(desc(schema.poolTrendRuns.createdAt))
        .limit(1);
      return [bucketKey(bucket.scope, bucket.category), row] as const;
    }),
  );
  return new Map(
    entries.filter((entry): entry is [string, BucketRunStatus] => entry[1] !== undefined),
  );
}

async function loadLatestIntelligenceRuns(
  ctx: WorkerContext,
  buckets: PoolBucket[],
): Promise<Map<string, BucketRunStatus>> {
  const entries = await Promise.all(
    buckets.map(async (bucket) => {
      const [row] = await ctx.db
        .select({
          status: schema.poolIntelligenceRuns.status,
          expiresAt: schema.poolIntelligenceRuns.expiresAt,
        })
        .from(schema.poolIntelligenceRuns)
        .where(
          and(
            eq(schema.poolIntelligenceRuns.scope, bucket.scope),
            bucket.category === null
              ? isNull(schema.poolIntelligenceRuns.category)
              : eq(schema.poolIntelligenceRuns.category, bucket.category),
          ),
        )
        .orderBy(desc(schema.poolIntelligenceRuns.createdAt))
        .limit(1);
      return [bucketKey(bucket.scope, bucket.category), row] as const;
    }),
  );
  return new Map(
    entries.filter((entry): entry is [string, BucketRunStatus] => entry[1] !== undefined),
  );
}

/** Inserts a queued run row and enqueues its job. A unique-violation on the
 *  insert means the bucket already has an active refresh in flight — from
 *  this same tick's prior run, or a brand's own lazy backfill racing it —
 *  and is skipped rather than treated as an error, the same concurrency
 *  case the partial unique index exists for (see `pool-loader.ts`). */
async function enqueueTrendBucket(ctx: WorkerContext, queue: Queue, bucket: PoolBucket): Promise<void> {
  try {
    const [run] = await ctx.db
      .insert(schema.poolTrendRuns)
      .values({ scope: bucket.scope, category: bucket.category })
      .returning({ id: schema.poolTrendRuns.id });
    if (!run) return;

    await queue.add(
      QUEUES.trendPoolResearch,
      { runId: run.id, scope: bucket.scope, category: bucket.category },
      { jobId: run.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );
    console.warn(`[pool-scheduler] enqueued trend refresh for ${bucketKey(bucket.scope, bucket.category)} (run ${run.id})`);
  } catch (error) {
    if (isUniqueViolation(error)) {
      console.warn(
        `[pool-scheduler] trend bucket ${bucketKey(bucket.scope, bucket.category)} already has an active refresh, skipping`,
      );
      return;
    }
    console.error(
      `[pool-scheduler] failed to enqueue trend refresh for ${bucketKey(bucket.scope, bucket.category)}: ${describeError(error)}`,
    );
  }
}

async function enqueueIntelligenceBucket(
  ctx: WorkerContext,
  queue: Queue,
  bucket: PoolBucket,
): Promise<void> {
  try {
    const [run] = await ctx.db
      .insert(schema.poolIntelligenceRuns)
      .values({ scope: bucket.scope, category: bucket.category })
      .returning({ id: schema.poolIntelligenceRuns.id });
    if (!run) return;

    await queue.add(
      QUEUES.intelligencePoolResearch,
      { runId: run.id, scope: bucket.scope, category: bucket.category },
      { jobId: run.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );
    console.warn(`[pool-scheduler] enqueued intelligence refresh for ${bucketKey(bucket.scope, bucket.category)} (run ${run.id})`);
  } catch (error) {
    if (isUniqueViolation(error)) {
      console.warn(
        `[pool-scheduler] intelligence bucket ${bucketKey(bucket.scope, bucket.category)} already has an active refresh, skipping`,
      );
      return;
    }
    console.error(
      `[pool-scheduler] failed to enqueue intelligence refresh for ${bucketKey(bucket.scope, bucket.category)}: ${describeError(error)}`,
    );
  }
}

/** The tick's processor: for each kind, find which buckets are stale and
 *  enqueue a refresh for each. */
export async function runPoolSchedulerTick(
  ctx: WorkerContext,
  trendPoolQueue: Queue,
  intelligencePoolQueue: Queue,
): Promise<void> {
  const now = new Date();
  const buckets = await loadActiveBuckets(ctx);

  const [latestTrend, latestIntelligence] = await Promise.all([
    loadLatestTrendRuns(ctx, buckets),
    loadLatestIntelligenceRuns(ctx, buckets),
  ]);

  const dueTrend = bucketsNeedingRefresh(buckets, latestTrend, now);
  const dueIntelligence = bucketsNeedingRefresh(buckets, latestIntelligence, now);

  console.warn(
    `[pool-scheduler] tick: ${buckets.length} active bucket(s) (${buckets.length - 1} category + national), ` +
      `${dueTrend.length} trend due, ${dueIntelligence.length} intelligence due`,
  );

  for (const bucket of dueTrend) await enqueueTrendBucket(ctx, trendPoolQueue, bucket);
  for (const bucket of dueIntelligence) await enqueueIntelligenceBucket(ctx, intelligencePoolQueue, bucket);
}

/** Registers the repeatable tick, idempotently — same reasoning as
 *  `scheduleResearchSchedulerTick`. */
export async function schedulePoolSchedulerTick(schedulerQueue: Queue): Promise<void> {
  await schedulerQueue.add(
    QUEUES.poolScheduler,
    {},
    {
      jobId: 'pool-scheduler-tick',
      repeat: { every: POOL_SCHEDULER_INTERVAL_HOURS * 3_600_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  );
}
