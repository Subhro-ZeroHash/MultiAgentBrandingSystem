import { describeError } from '@bmas/ai';
import { and, asc, eq, inArray, lt, lte, reapAllStalledBrandRuns, schema } from '@bmas/db';
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

/**
 * Most brands one tick will start research for.
 *
 * Every brand taken here costs two provider-backed jobs (a web search plus a
 * synthesis pass, twice over), and brands become due in clusters rather than
 * evenly — a cohort that signs up together and enables automation together
 * stays synchronised for as long as they share a cadence. Without a ceiling,
 * one tick of a hundred such brands is two hundred billable jobs enqueued in a
 * burst, against provider quotas that are the scarcest thing this system has.
 *
 * Overflow is not dropped: it stays due (its `nextResearchAt` is only advanced
 * once it has actually been enqueued) and is picked up by the following tick,
 * oldest-due first.
 */
const MAX_BRANDS_PER_TICK = 25;

async function getDueBrands(ctx: WorkerContext, now: Date): Promise<DueBrand[]> {
  return (
    ctx.db
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
      )
      // Longest-overdue first, so a brand that loses one tick to the cap is at
      // the front of the next one. Without the ordering the cap could starve the
      // same brands indefinitely, since the unordered scan tends to be stable.
      .orderBy(asc(schema.automationSettings.nextResearchAt))
      .limit(MAX_BRANDS_PER_TICK)
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
/**
 * Backstop for runs frozen by a worker that died mid-job — see
 * `reapAllStalledBrandRuns` in @bmas/db for the full reasoning.
 *
 * The API already reaps a stalled run when someone reads it, which is what
 * spares a waiting client its seven-minute spinner. This catches the rest: a
 * run nobody is watching (the user closed the app) is never read, so it is
 * never reaped there and would otherwise sit non-terminal indefinitely.
 *
 * Nothing depends on this being prompt. Unlike a stalled *pool* run, which
 * holds its bucket's only active-refresh slot and wedges it, a stalled
 * per-brand run blocks nothing — the feed reads only `succeeded` runs and
 * starting another is never gated on one finishing. So a tick interval
 * measured in hours is the right cadence for what is really bookkeeping.
 *
 * Never throws: this is housekeeping attached to the tick, and it must not
 * cost the tick the brand research it actually exists to enqueue.
 */
async function sweepStalledRuns(ctx: WorkerContext, now: Date): Promise<void> {
  try {
    const { trend, intelligence, video } = await reapAllStalledBrandRuns(ctx.db, now);
    const total = trend.length + intelligence.length + video.length;
    if (total === 0) return;
    console.warn(
      `[research-scheduler] reaped ${total} stalled run(s) — ${trend.length} trend, ${intelligence.length} intelligence, ${video.length} video`,
    );
  } catch (error) {
    console.error(`[research-scheduler] stalled-run sweep failed: ${describeError(error)}`);
  }
}

/** A week with no login, refresh, or `/auth/me` call from the owner. Chosen
 *  over a shorter window (a person skipping a long weekend is normal) —
 *  content-api's AutopilotActivityService is the other half of this: it
 *  resumes and immediately re-researches everything this pauses the moment
 *  the owner is next seen. */
const INACTIVITY_PAUSE_MS = 7 * 24 * 60 * 60_000;

/**
 * Pauses autopilot for brands whose owner has gone quiet.
 *
 * Scoped to `content_automation_enabled = true` rows only — nothing to pause
 * on a brand that's already manual, and that same condition is what makes
 * this safe to run every tick: a brand this already paused now reads as
 * disabled, so it drops out of the query on its own and `autoPausedAt` never
 * gets re-stamped with a later time while the owner is still away.
 *
 * Two steps rather than one UPDATE ... FROM: Drizzle's update() has no join
 * clause, so the brands that qualify are selected first (via the owner's
 * `users.lastActiveAt`) and updated by id.
 *
 * Never throws, same reasoning as sweepStalledRuns: this is background
 * housekeeping riding along on the tick, not the reason the tick exists.
 */
async function sweepInactiveAutomation(ctx: WorkerContext, now: Date): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - INACTIVITY_PAUSE_MS);

    const stale = await ctx.db
      .select({ id: schema.automationSettings.id })
      .from(schema.automationSettings)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.automationSettings.brandId))
      .innerJoin(schema.users, eq(schema.users.id, schema.brands.ownerId))
      .where(
        and(
          eq(schema.automationSettings.contentAutomationEnabled, true),
          lt(schema.users.lastActiveAt, cutoff),
        ),
      );

    if (stale.length === 0) return;

    const paused = await ctx.db
      .update(schema.automationSettings)
      .set({ contentAutomationEnabled: false, autoPausedAt: now, updatedAt: now })
      .where(
        inArray(
          schema.automationSettings.id,
          stale.map((row) => row.id),
        ),
      )
      .returning({ id: schema.automationSettings.id });

    console.warn(`[research-scheduler] paused autopilot on ${paused.length} brand(s) — owner inactive 7+ days`);
  } catch (error) {
    console.error(`[research-scheduler] inactivity sweep failed: ${describeError(error)}`);
  }
}

export async function runResearchSchedulerTick(
  ctx: WorkerContext,
  trendQueue: Queue,
  intelligenceQueue: Queue,
): Promise<void> {
  const now = new Date();

  // Before the early return below, deliberately: most ticks find no brands
  // due, and a sweep placed after that check would almost never run.
  await sweepStalledRuns(ctx, now);
  await sweepInactiveAutomation(ctx, now);

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
