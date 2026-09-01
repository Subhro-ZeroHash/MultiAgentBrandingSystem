import { eq, schema } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from './context.js';

/**
 * Registers the cron schedules that drive the whole pipeline.
 *
 * These are BullMQ job schedulers, not node-cron: the schedule lives in Redis
 * rather than in a process, so it survives a restart, and two worker replicas
 * produce one tick rather than two. `upsertJobScheduler` is keyed and
 * idempotent, which is what lets the sync below run repeatedly and cheaply.
 */

const PROMPT_PREFIX = 'prompt-';
const ROLLUP_SCHEDULER_ID = 'rollup-tick';
// Deliberately does NOT start with `prompt-`: the cleanup loop in
// `syncPromptSchedulers` below removes any scheduler key with that prefix it
// doesn't recognise as a live tracked-prompt id, on the assumption every such
// key is a per-prompt schedule. A `prompt-suggestions-tick` name collided
// with that assumption — created here, deleted as "orphaned" on the very
// next sync (it runs every `GEO_SCHEDULER_SYNC_MS`), silently, no error.
const SUGGEST_PROMPTS_SCHEDULER_ID = 'suggest-prompts-tick';

const TICK_JOB_OPTS = {
  // A missed tick is better than a pile of them: the next one re-reads state.
  attempts: 1,
  removeOnComplete: 200,
  removeOnFail: 500,
} as const;

export interface SyncResult {
  active: number;
  removed: number;
  invalid: string[];
}

/**
 * Reconciles one scheduler per active tracked prompt against the database.
 *
 * Prompts are created through geo-api, which has no connection to the worker's
 * queues, so this runs on an interval rather than being called at write time —
 * a new prompt starts probing within one sync period without a deploy.
 */
export async function syncPromptSchedulers(
  ctx: WorkerContext,
  sweepQueue: Queue,
): Promise<SyncResult> {
  const prompts = await ctx.db
    .select({ id: schema.trackedPrompts.id, schedule: schema.trackedPrompts.schedule })
    .from(schema.trackedPrompts)
    .where(eq(schema.trackedPrompts.isActive, true));

  const invalid: string[] = [];
  const wanted = new Set<string>();

  for (const prompt of prompts) {
    const schedulerId = `${PROMPT_PREFIX}${prompt.id}`;
    try {
      await sweepQueue.upsertJobScheduler(
        schedulerId,
        { pattern: prompt.schedule },
        {
          name: QUEUES.geoSweep,
          data: { kind: 'prompt', promptId: prompt.id },
          opts: TICK_JOB_OPTS,
        },
      );
      wanted.add(schedulerId);
    } catch (error) {
      // `schedule` is user-supplied text with no CHECK constraint behind it. One
      // malformed cron must not stop the other prompts from being scheduled.
      invalid.push(prompt.id);
      console.error(
        `[scheduler] prompt ${prompt.id} has an unusable cron ${JSON.stringify(prompt.schedule)}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Deactivated and deleted prompts leave their scheduler behind in Redis;
  // without this they keep firing ticks for rows that no longer qualify.
  const existing = await sweepQueue.getJobSchedulers(0, -1, true);
  let removed = 0;
  for (const scheduler of existing) {
    if (!scheduler.key.startsWith(PROMPT_PREFIX)) continue;
    if (wanted.has(scheduler.key)) continue;
    await sweepQueue.removeJobScheduler(scheduler.key);
    removed += 1;
  }

  return { active: wanted.size, removed, invalid };
}

/**
 * One global roll-up tick rather than one per brand: the tick carries no
 * payload and fans out to whichever brands are active when it fires, so brands
 * can come and go without touching a scheduler.
 */
export async function ensureRollupScheduler(ctx: WorkerContext, sweepQueue: Queue): Promise<void> {
  await sweepQueue.upsertJobScheduler(
    ROLLUP_SCHEDULER_ID,
    { pattern: ctx.scheduler.rollupCron },
    { name: QUEUES.geoSweep, data: { kind: 'rollup' }, opts: TICK_JOB_OPTS },
  );
}

/**
 * Same shape as the roll-up tick, same cron — one daily maintenance cadence
 * for both rather than a second env var to reason about. Unlike roll-up, this
 * has to be discoverable independent of `tracked_prompts`: a brand that has
 * never had a single prompt still needs autopilot to seed one, which is
 * exactly the case `enqueueRollups`' own brand query (sourced from
 * `tracked_prompts`) can never see.
 */
export async function ensurePromptSuggestionScheduler(
  ctx: WorkerContext,
  sweepQueue: Queue,
): Promise<void> {
  await sweepQueue.upsertJobScheduler(
    SUGGEST_PROMPTS_SCHEDULER_ID,
    { pattern: ctx.scheduler.rollupCron },
    { name: QUEUES.geoSweep, data: { kind: 'prompt-suggestions' }, opts: TICK_JOB_OPTS },
  );
}
