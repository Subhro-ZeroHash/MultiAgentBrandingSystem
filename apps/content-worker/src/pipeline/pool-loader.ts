import { and, desc, eq, gte, isNull, lt, or, schema } from '@bmas/db';
import type { CategoryKey, PoolRunScope } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { runIntelligencePoolRefresh } from './intelligence-pool-refresh.js';
import { runTrendPoolRefresh } from './trend-pool-refresh.js';

/**
 * Loads a bucket's current pool, refreshing it inline if it has gone stale.
 *
 * This is what guarantees a brand is never left with zero data even for a
 * bucket that has never run — Layer B calls this instead of falling back to
 * its old per-brand search. The refresh runs synchronously inside the
 * caller's own job rather than being enqueued and awaited via a second
 * BullMQ round trip: the brand's own research run just takes longer this one
 * time (the same cost the old per-brand pipeline always paid, just now paid
 * once per bucket instead of once per brand), and no cross-job coordination
 * is needed.
 *
 * The partial unique index on `(scope, category) WHERE status IN
 * ('queued','running')` (see the "Global Research Pool" section of
 * content.ts) is what makes concurrent callers safe: if the pool scheduler's
 * tick and a brand's lazy backfill both decide the same bucket is stale at
 * once, only one of them wins the insert — the loser polls for the winner's
 * run to finish instead of running a second, redundant refresh.
 */

const POOL_BACKFILL_POLL_INTERVAL_MS = 3_000;
const POOL_BACKFILL_POLL_TIMEOUT_MS = 5 * 60_000;

/** A run stuck in 'queued'/'running' longer than this is presumed dead — the
 *  worker process that owned it crashed or was killed rather than throwing,
 *  so the `catch` in runTrendPoolRefresh/runIntelligencePoolRefresh that
 *  would normally flip it to 'failed' never ran. Left alone, the partial
 *  unique index on (scope, category) keeps treating that row as an active
 *  refresh forever: every future caller for the bucket hits the
 *  unique-violation branch below and either polls until its own 5-minute
 *  timeout or (from pool-scheduler.ts) is silently skipped, so the bucket
 *  never gets refreshed again. Comfortably above how long a real run takes
 *  (search + LLM synthesis), well below the 6-hour scheduler interval. */
const STALLED_RUN_TIMEOUT_MS = 15 * 60_000;

/** Postgres error code 23505 is unique_violation; Drizzle wraps the driver's
 *  error rather than exposing `.code` directly, so it has to be read off
 *  `.cause` — same detection generations.service.ts already uses for
 *  `asset_edits_one_active_per_root_idx`. Exported so pool-scheduler.ts's
 *  tick can recognize the identical race against its own insert. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { cause?: { code?: string } })?.cause?.code === '23505';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PoolBucketInput = (
  | { scope: 'category'; category: CategoryKey }
  | { scope: 'national' }
) & {
  /** ISO country the bucket covers. Part of the key, so two brands in
   *  different markets never share a pool — see PoolBucket in @bmas/shared. */
  market: string;
};

function bucketColumns(bucket: PoolBucketInput): {
  scope: PoolRunScope;
  category: CategoryKey | null;
  market: string;
} {
  return bucket.scope === 'national'
    ? { scope: 'national', category: null, market: bucket.market }
    : { scope: 'category', category: bucket.category, market: bucket.market };
}

function bucketLabel(scope: PoolRunScope, category: CategoryKey | null, market: string): string {
  return `${category ? `${scope}:${category}` : scope}@${market}`;
}

// ---------------------------------------------------------------------------
// Trend pool
// ---------------------------------------------------------------------------

export interface TrendPoolResult {
  runId: string;
  items: (typeof schema.poolTrendItems.$inferSelect)[];
}

async function findFreshTrendRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
): Promise<TrendPoolResult | null> {
  const [run] = await ctx.db
    .select({ id: schema.poolTrendRuns.id })
    .from(schema.poolTrendRuns)
    .where(
      and(
        eq(schema.poolTrendRuns.scope, scope),
        category === null
          ? isNull(schema.poolTrendRuns.category)
          : eq(schema.poolTrendRuns.category, category),
        eq(schema.poolTrendRuns.market, market),
        eq(schema.poolTrendRuns.status, 'succeeded'),
        gte(schema.poolTrendRuns.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.poolTrendRuns.createdAt))
    .limit(1);
  if (!run) return null;

  const items = await ctx.db
    .select()
    .from(schema.poolTrendItems)
    .where(eq(schema.poolTrendItems.runId, run.id));
  return { runId: run.id, items };
}

/** Marks the bucket's active run 'failed' if it has been queued/running
 *  longer than STALLED_RUN_TIMEOUT_MS. Returns true if it reaped one, in
 *  which case the caller's insert (blocked by the unique index on the row
 *  this just failed) is worth retrying once. */
async function reapStalledTrendRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
  label: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - STALLED_RUN_TIMEOUT_MS);
  const reaped = await ctx.db
    .update(schema.poolTrendRuns)
    .set({
      status: 'failed',
      error: 'stalled: exceeded run timeout, presumed crashed',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.poolTrendRuns.scope, scope),
        category === null
          ? isNull(schema.poolTrendRuns.category)
          : eq(schema.poolTrendRuns.category, category),
        eq(schema.poolTrendRuns.market, market),
        or(eq(schema.poolTrendRuns.status, 'queued'), eq(schema.poolTrendRuns.status, 'running')),
        lt(schema.poolTrendRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.poolTrendRuns.id });
  if (reaped[0]) {
    console.warn(
      `[pool-loader] trend pool '${label}' had a stalled run (${reaped[0].id}), marking it failed`,
    );
    return true;
  }
  return false;
}

export async function ensureFreshTrendPool(
  ctx: WorkerContext,
  bucket: PoolBucketInput,
): Promise<TrendPoolResult> {
  const { scope, category, market } = bucketColumns(bucket);
  const label = bucketLabel(scope, category, market);

  const fresh = await findFreshTrendRun(ctx, scope, category, market);
  if (fresh) {
    console.warn(
      `[pool-loader] trend pool '${label}' is fresh (run ${fresh.runId}, ${fresh.items.length} items) — reusing, no search needed`,
    );
    return fresh;
  }

  let runId: string;
  try {
    const [inserted] = await ctx.db
      .insert(schema.poolTrendRuns)
      .values({ scope, category, market })
      .returning({ id: schema.poolTrendRuns.id });
    if (!inserted) throw new Error('Insert returned no row');
    runId = inserted.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    if (await reapStalledTrendRun(ctx, scope, category, market, label)) {
      return ensureFreshTrendPool(ctx, bucket);
    }
    console.warn(
      `[pool-loader] trend pool '${label}' is already being refreshed elsewhere — waiting...`,
    );
    return pollForFreshTrendRun(ctx, scope, category, market);
  }

  console.warn(
    `[pool-loader] trend pool '${label}' is stale/missing — running inline refresh (run ${runId})`,
  );
  // Propagates on failure — Layer B should fail loudly rather than proceed
  // with no data when its bucket's refresh genuinely fails.
  await runTrendPoolRefresh(ctx, { runId, scope, category, market });

  const result = await findFreshTrendRun(ctx, scope, category, market);
  if (!result) throw new Error(`Pool trend refresh ${runId} did not produce a fresh run`);
  return result;
}

async function pollForFreshTrendRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
): Promise<TrendPoolResult> {
  const deadline = Date.now() + POOL_BACKFILL_POLL_TIMEOUT_MS;
  for (;;) {
    const fresh = await findFreshTrendRun(ctx, scope, category, market);
    if (fresh) return fresh;

    const [latest] = await ctx.db
      .select({ status: schema.poolTrendRuns.status })
      .from(schema.poolTrendRuns)
      .where(
        and(
          eq(schema.poolTrendRuns.scope, scope),
          category === null
            ? isNull(schema.poolTrendRuns.category)
            : eq(schema.poolTrendRuns.category, category),
          eq(schema.poolTrendRuns.market, market),
        ),
      )
      .orderBy(desc(schema.poolTrendRuns.createdAt))
      .limit(1);
    if (latest?.status === 'failed') {
      throw new Error(`Concurrent trend pool refresh for this bucket failed`);
    }
    if (Date.now() >= deadline) {
      // The run outlived our poll window but not yet STALLED_RUN_TIMEOUT_MS —
      // still reap it if it has now crossed that line, so the *next* caller
      // (rather than every caller forever) doesn't hit the same wait.
      await reapStalledTrendRun(ctx, scope, category, market, bucketLabel(scope, category, market));
      throw new Error('Timed out waiting for a concurrent trend pool refresh to finish');
    }
    await sleep(POOL_BACKFILL_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Intelligence pool
// ---------------------------------------------------------------------------

export interface IntelligencePoolResult {
  runId: string;
  items: (typeof schema.poolIntelligenceItems.$inferSelect)[];
}

async function findFreshIntelligenceRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
): Promise<IntelligencePoolResult | null> {
  const [run] = await ctx.db
    .select({ id: schema.poolIntelligenceRuns.id })
    .from(schema.poolIntelligenceRuns)
    .where(
      and(
        eq(schema.poolIntelligenceRuns.scope, scope),
        category === null
          ? isNull(schema.poolIntelligenceRuns.category)
          : eq(schema.poolIntelligenceRuns.category, category),
        eq(schema.poolIntelligenceRuns.market, market),
        eq(schema.poolIntelligenceRuns.status, 'succeeded'),
        gte(schema.poolIntelligenceRuns.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.poolIntelligenceRuns.createdAt))
    .limit(1);
  if (!run) return null;

  const items = await ctx.db
    .select()
    .from(schema.poolIntelligenceItems)
    .where(eq(schema.poolIntelligenceItems.runId, run.id));
  return { runId: run.id, items };
}

/** Intelligence-table counterpart of reapStalledTrendRun — same reasoning. */
async function reapStalledIntelligenceRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
  label: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - STALLED_RUN_TIMEOUT_MS);
  const reaped = await ctx.db
    .update(schema.poolIntelligenceRuns)
    .set({
      status: 'failed',
      error: 'stalled: exceeded run timeout, presumed crashed',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.poolIntelligenceRuns.scope, scope),
        category === null
          ? isNull(schema.poolIntelligenceRuns.category)
          : eq(schema.poolIntelligenceRuns.category, category),
        eq(schema.poolIntelligenceRuns.market, market),
        or(
          eq(schema.poolIntelligenceRuns.status, 'queued'),
          eq(schema.poolIntelligenceRuns.status, 'running'),
        ),
        lt(schema.poolIntelligenceRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.poolIntelligenceRuns.id });
  if (reaped[0]) {
    console.warn(
      `[pool-loader] intelligence pool '${label}' had a stalled run (${reaped[0].id}), marking it failed`,
    );
    return true;
  }
  return false;
}

export async function ensureFreshIntelligencePool(
  ctx: WorkerContext,
  bucket: PoolBucketInput,
): Promise<IntelligencePoolResult> {
  const { scope, category, market } = bucketColumns(bucket);
  const label = bucketLabel(scope, category, market);

  const fresh = await findFreshIntelligenceRun(ctx, scope, category, market);
  if (fresh) {
    console.warn(
      `[pool-loader] intelligence pool '${label}' is fresh (run ${fresh.runId}, ${fresh.items.length} items) — reusing, no search needed`,
    );
    return fresh;
  }

  let runId: string;
  try {
    const [inserted] = await ctx.db
      .insert(schema.poolIntelligenceRuns)
      .values({ scope, category, market })
      .returning({ id: schema.poolIntelligenceRuns.id });
    if (!inserted) throw new Error('Insert returned no row');
    runId = inserted.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    if (await reapStalledIntelligenceRun(ctx, scope, category, market, label)) {
      return ensureFreshIntelligencePool(ctx, bucket);
    }
    console.warn(
      `[pool-loader] intelligence pool '${label}' is already being refreshed elsewhere — waiting...`,
    );
    return pollForFreshIntelligenceRun(ctx, scope, category, market);
  }

  console.warn(
    `[pool-loader] intelligence pool '${label}' is stale/missing — running inline refresh (run ${runId})`,
  );
  await runIntelligencePoolRefresh(ctx, { runId, scope, category, market });

  const result = await findFreshIntelligenceRun(ctx, scope, category, market);
  if (!result) throw new Error(`Pool intelligence refresh ${runId} did not produce a fresh run`);
  return result;
}

async function pollForFreshIntelligenceRun(
  ctx: WorkerContext,
  scope: PoolRunScope,
  category: CategoryKey | null,
  market: string,
): Promise<IntelligencePoolResult> {
  const deadline = Date.now() + POOL_BACKFILL_POLL_TIMEOUT_MS;
  for (;;) {
    const fresh = await findFreshIntelligenceRun(ctx, scope, category, market);
    if (fresh) return fresh;

    const [latest] = await ctx.db
      .select({ status: schema.poolIntelligenceRuns.status })
      .from(schema.poolIntelligenceRuns)
      .where(
        and(
          eq(schema.poolIntelligenceRuns.scope, scope),
          category === null
            ? isNull(schema.poolIntelligenceRuns.category)
            : eq(schema.poolIntelligenceRuns.category, category),
          eq(schema.poolIntelligenceRuns.market, market),
        ),
      )
      .orderBy(desc(schema.poolIntelligenceRuns.createdAt))
      .limit(1);
    if (latest?.status === 'failed') {
      throw new Error(`Concurrent intelligence pool refresh for this bucket failed`);
    }
    if (Date.now() >= deadline) {
      await reapStalledIntelligenceRun(ctx, scope, category, market, bucketLabel(scope, category, market));
      throw new Error('Timed out waiting for a concurrent intelligence pool refresh to finish');
    }
    await sleep(POOL_BACKFILL_POLL_INTERVAL_MS);
  }
}
