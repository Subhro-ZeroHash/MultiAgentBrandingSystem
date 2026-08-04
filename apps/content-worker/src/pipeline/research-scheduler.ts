import { describeError } from '@bmas/ai';
import { and, eq, lte, schema } from '@bmas/db';
import { nextResearchAt, QUEUES, RESEARCH_SCHEDULER_INTERVAL_HOURS } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';

/**
 * Autonomous research scheduler.
 *
 * The "set it and forget it" half of the spec: a brand with automation turned
 * on should not need a human to tap "Find Trending Content Ideas" or "Refresh
 * My Intelligence Feed" ever again. `automation_settings.getBrandsDueForResearch`
 * (content-api's `AutomationSettingsService`) already had the query this needs
 * — enabled brands whose `next_research_at` has come — but nothing ever called
 * it. This is that caller.
 *
 * Runs as one repeatable BullMQ job (`scheduler-tick`, fixed id so re-deploys
 * don't accumulate duplicate schedules) firing every
 * RESEARCH_SCHEDULER_INTERVAL_HOURS. That interval is how often the scheduler
 * *checks*, not how often any one brand gets researched — a brand's own
 * cadence (daily / three_days / weekly) is what `next_research_at` encodes,
 * and this tick is just fine-grained enough that a brand due for "daily"
 * research doesn't drift by more than the tick interval.
 *
 * Lives in content-worker rather than content-api because every write it
 * needs (trend_research_runs, intelligence_runs, automation_settings) is
 * already reachable through `@bmas/db` here, and the two queues it enqueues
 * into are consumed by workers in this same process. Duplicating
 * `AutomationSettingsService`'s ownership-checked HTTP surface for an
 * unattended job that runs with no request context to check ownership
 * against would be the wrong kind of reuse.
 */

interface DueBrand {
  brandId: string;
  trendFrequency: (typeof schema.trendFrequency.enumValues)[number];
  lastResearchAt: Date | null;
}

async function getDueBrands(ctx: WorkerContext, now: Date): Promise<DueBrand[]> {
  return ctx.db
    .select({
      brandId: schema.automationSettings.brandId,
      trendFrequency: schema.automationSettings.trendFrequency,
      lastResearchAt: schema.automationSettings.lastResearchAt,
    })
    .from(schema.automationSettings)
    .where(
      and(
        eq(schema.automationSettings.contentAutomationEnabled, true),
        lte(schema.automationSettings.nextResearchAt, now),
      ),
    );
}

/**
 * Enqueues both research agents for one due brand and books its next run.
 *
 * The `nextResearchAt` advance happens here, before either job has actually
 * run — mirroring `markResearchExecuted`'s own comment about *why* it stamps
 * on completion rather than enqueue for the user-triggered path would be
 * backwards for the scheduler specifically: if this tick stamped only after a
 * job finished, a crashed worker would leave the brand stuck at "due" forever,
 * and every subsequent tick would re-enqueue it into an ever-growing queue
 * backlog instead of trying again next cadence like it should.
 */
async function enqueueForBrand(
  ctx: WorkerContext,
  trendQueue: Queue,
  intelligenceQueue: Queue,
  brand: DueBrand,
  now: Date,
): Promise<void> {
  const [trendRun] = await ctx.db
    .insert(schema.trendResearchRuns)
    .values({ brandId: brand.brandId })
    .returning();
  const [intelligenceRun] = await ctx.db
    .insert(schema.intelligenceRuns)
    .values({ brandId: brand.brandId })
    .returning();

  if (trendRun) {
    await trendQueue.add(
      QUEUES.trendResearch,
      { runId: trendRun.id, brandId: brand.brandId },
      { jobId: trendRun.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );
  }
  if (intelligenceRun) {
    await intelligenceQueue.add(
      QUEUES.intelligenceResearch,
      { runId: intelligenceRun.id, brandId: brand.brandId },
      { jobId: intelligenceRun.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );
  }

  await ctx.db
    .update(schema.automationSettings)
    .set({
      lastResearchAt: now,
      nextResearchAt: nextResearchAt(brand.trendFrequency, now, now),
      updatedAt: now,
    })
    .where(eq(schema.automationSettings.brandId, brand.brandId));
}

/** The tick's processor: find who's due, enqueue for each, log what happened.
 *  One brand failing to enqueue (a bad insert, a Redis blip) is logged and
 *  skipped rather than aborting the tick — the other due brands still deserve
 *  their research this round. */
export async function runResearchSchedulerTick(
  ctx: WorkerContext,
  trendQueue: Queue,
  intelligenceQueue: Queue,
): Promise<void> {
  const now = new Date();
  const due = await getDueBrands(ctx, now);

  if (due.length === 0) {
    console.warn('[research-scheduler] tick: no brands due');
    return;
  }

  console.warn(`[research-scheduler] tick: ${due.length} brand(s) due`);

  for (const brand of due) {
    try {
      await enqueueForBrand(ctx, trendQueue, intelligenceQueue, brand, now);
    } catch (error) {
      console.error(
        `[research-scheduler] failed to enqueue research for brand ${brand.brandId}: ${describeError(error)}`,
      );
    }
  }
}

/** Registers the repeatable tick, idempotently. BullMQ dedupes repeatable
 *  jobs by their repeat key, so calling this on every process boot is safe —
 *  a redeploy does not stack up a second schedule running alongside the
 *  first. */
export async function scheduleResearchSchedulerTick(schedulerQueue: Queue): Promise<void> {
  await schedulerQueue.add(
    QUEUES.researchScheduler,
    {},
    {
      jobId: 'scheduler-tick',
      repeat: { every: RESEARCH_SCHEDULER_INTERVAL_HOURS * 3_600_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  );
}
