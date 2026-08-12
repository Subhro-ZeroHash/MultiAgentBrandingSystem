import { eq, schema } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';

/**
 * Turns a scheduler tick into actual work. Nothing here talks to a provider —
 * it only decides what should run and hands it to the probe and roll-up queues.
 */

const PROBE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
} as const;

/** Hour bucket used for job ids, so a re-fired tick collapses onto one run. */
function hourKey(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/**
 * Fans out one probe job per (prompt, engine) — the same shape the manual
 * `POST /prompts/:id/probe` path produces, so scheduled and manual runs are
 * indistinguishable downstream.
 */
export async function sweepPrompt(
  ctx: WorkerContext,
  probeQueue: Queue,
  promptId: string,
): Promise<number> {
  const [prompt] = await ctx.db
    .select()
    .from(schema.trackedPrompts)
    .where(eq(schema.trackedPrompts.id, promptId))
    .limit(1);

  // The scheduler is removed on the next sync, but a tick already in flight can
  // outlive a prompt being deactivated or deleted.
  if (!prompt || !prompt.isActive || prompt.engines.length === 0) return 0;

  const bucket = hourKey(new Date());
  await probeQueue.addBulk(
    prompt.engines.map((engine) => ({
      name: QUEUES.geoProbe,
      data: { promptId: prompt.id, brandId: prompt.brandId, engine },
      opts: { jobId: `${prompt.id}-${engine}-${bucket}`, ...PROBE_JOB_OPTS },
    })),
  );

  return prompt.engines.length;
}

/**
 * Enqueues one roll-up per brand that still has active prompts, over a trailing
 * window. Deliberately decoupled from sweep completion: a roll-up aggregates
 * whatever runs exist in its window, so it does not need to know whether every
 * probe of a given cycle has landed, and a slow engine can't starve the metric.
 */
export async function enqueueRollups(ctx: WorkerContext, rollupQueue: Queue): Promise<number> {
  const brands = await ctx.db
    .selectDistinct({ brandId: schema.trackedPrompts.brandId })
    .from(schema.trackedPrompts)
    .where(eq(schema.trackedPrompts.isActive, true));

  if (brands.length === 0) return 0;

  const periodEnd = new Date();
  const periodStart = new Date(
    periodEnd.getTime() - ctx.scheduler.rollupWindowDays * 24 * 60 * 60 * 1_000,
  );
  const bucket = hourKey(periodEnd);

  await rollupQueue.addBulk(
    brands.map(({ brandId }) => ({
      name: QUEUES.geoRollup,
      data: { brandId, periodStart, periodEnd },
      opts: {
        jobId: `${brandId}-${bucket}`,
        attempts: 2,
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    })),
  );

  return brands.length;
}
