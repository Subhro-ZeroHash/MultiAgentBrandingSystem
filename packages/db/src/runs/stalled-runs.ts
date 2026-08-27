import { and, eq, lt, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * Reaping stalled per-brand research runs.
 *
 * A run is supposed to always reach a terminal status: `succeeded`, or
 * `failed` set by the `catch` in the worker's pipeline. That `catch` is the
 * guarantee — and it only holds while JavaScript is still running. If the
 * process itself dies (pm2 restart mid-job, OOM kill, host reboot), no code
 * executes at all and the row is frozen at `queued`/`running` forever.
 *
 * This is the per-brand counterpart of `reapStalledTrendRun` in the worker's
 * pool-loader.ts, but it exists for a different reason and so it fires from a
 * different place.
 *
 * The pool version prevents a deadlock: a partial unique index on
 * `(scope, category, market) WHERE status IN ('queued','running')` means a
 * frozen pool row keeps occupying its bucket's only "active refresh" slot, so
 * every later caller either polls it out or is silently skipped and the bucket
 * never refreshes again. There, the caller who loses the insert race is the one
 * who finds the corpse, so that caller reaps it.
 *
 * Per-brand runs have no such index and nothing blocks on them — a frozen row
 * cannot wedge anything. What it does instead is waste the user's time: the
 * mobile client polls a run every 1.5s and only gives up after 420s, so a
 * crashed run costs seven minutes of spinner before a generic timeout, when the
 * truth was knowable in seconds. Here the caller who finds the corpse is
 * whoever reads the run, which is why `reapStalledTrendResearchRun` is called
 * from the API's `getRun` — the polling client then sees a real `failed` with a
 * real reason on its very next tick.
 *
 * `reapAllStalledBrandRuns` is the backstop for runs nobody is watching (the
 * user closed the app), so the tables stay honest rather than accumulating rows
 * that are never read and therefore never reaped.
 */

/**
 * How long a run may sit non-terminal before it is presumed dead.
 *
 * There is no heartbeat or process registry to consult, so age is the only
 * evidence available. Deliberately generous: a per-brand run can legitimately
 * take minutes, and it may additionally block on an inline pool refresh with
 * its own five-minute poll window, so anything much tighter would reap runs
 * that are genuinely still working. Matches the pool reaper's threshold.
 */
export const STALLED_RUN_TIMEOUT_MS = 15 * 60_000;

/** Recorded verbatim in `error`, matching what the pool reaper writes, so the
 *  two are greppable as one class of event rather than two. */
export const STALLED_RUN_ERROR = 'stalled: exceeded run timeout, presumed crashed';

function stalledCutoff(now: Date): Date {
  return new Date(now.getTime() - STALLED_RUN_TIMEOUT_MS);
}

/**
 * Marks one trend research run failed if it is both non-terminal and older
 * than the timeout. Returns true only when it actually changed a row.
 *
 * The two `WHERE` conditions are what make this safe to call on any run at
 * all, including from a plain GET: a terminal run is never touched, and a run
 * still inside the window is never touched. There is no state in which calling
 * this can damage a healthy run, which is what lets the read path call it
 * unconditionally instead of first deciding whether it ought to.
 */
export async function reapStalledTrendResearchRun(
  db: Database,
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const reaped = await db
    .update(schema.trendResearchRuns)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        eq(schema.trendResearchRuns.id, runId),
        or(
          eq(schema.trendResearchRuns.status, 'queued'),
          eq(schema.trendResearchRuns.status, 'running'),
        ),
        lt(schema.trendResearchRuns.createdAt, stalledCutoff(now)),
      ),
    )
    .returning({ id: schema.trendResearchRuns.id });
  return reaped.length > 0;
}

/** The intelligence counterpart. Separate rather than generic for the same
 *  reason pool-loader.ts keeps its two apart: the tables carry different
 *  status enums, and unifying them buys a few saved lines at the cost of the
 *  type safety that makes either one obviously correct. */
export async function reapStalledIntelligenceRun(
  db: Database,
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const reaped = await db
    .update(schema.intelligenceRuns)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        eq(schema.intelligenceRuns.id, runId),
        or(
          eq(schema.intelligenceRuns.status, 'queued'),
          eq(schema.intelligenceRuns.status, 'running'),
        ),
        lt(schema.intelligenceRuns.createdAt, stalledCutoff(now)),
      ),
    )
    .returning({ id: schema.intelligenceRuns.id });
  return reaped.length > 0;
}

/** Video's counterpart — added after the other two, when video_generation_jobs
 *  didn't exist yet, for the same reason and against the same job status
 *  enum every other job table in `content` shares. */
export async function reapStalledVideoGenerationJob(
  db: Database,
  jobId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const reaped = await db
    .update(schema.videoGenerationJobs)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        eq(schema.videoGenerationJobs.id, jobId),
        or(
          eq(schema.videoGenerationJobs.status, 'queued'),
          eq(schema.videoGenerationJobs.status, 'running'),
        ),
        lt(schema.videoGenerationJobs.createdAt, stalledCutoff(now)),
      ),
    )
    .returning({ id: schema.videoGenerationJobs.id });
  return reaped.length > 0;
}

/**
 * Sweeps every stalled per-brand run, whether or not anyone is reading it.
 *
 * Unbounded on purpose, unlike the scheduler's `MAX_BRANDS_PER_TICK`: that
 * ceiling exists because each brand it takes costs provider-backed jobs, and
 * this costs two UPDATEs no matter how many rows match. Capping it would only
 * mean carrying known-dead rows to the next tick for no saving.
 */
export async function reapAllStalledBrandRuns(
  db: Database,
  now: Date = new Date(),
): Promise<{ trend: string[]; intelligence: string[]; video: string[] }> {
  const cutoff = stalledCutoff(now);

  const trend = await db
    .update(schema.trendResearchRuns)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        or(
          eq(schema.trendResearchRuns.status, 'queued'),
          eq(schema.trendResearchRuns.status, 'running'),
        ),
        lt(schema.trendResearchRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.trendResearchRuns.id });

  const intelligence = await db
    .update(schema.intelligenceRuns)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        or(
          eq(schema.intelligenceRuns.status, 'queued'),
          eq(schema.intelligenceRuns.status, 'running'),
        ),
        lt(schema.intelligenceRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.intelligenceRuns.id });

  const video = await db
    .update(schema.videoGenerationJobs)
    .set({ status: 'failed', error: STALLED_RUN_ERROR, finishedAt: now })
    .where(
      and(
        or(
          eq(schema.videoGenerationJobs.status, 'queued'),
          eq(schema.videoGenerationJobs.status, 'running'),
        ),
        lt(schema.videoGenerationJobs.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.videoGenerationJobs.id });

  return {
    trend: trend.map((row) => row.id),
    intelligence: intelligence.map((row) => row.id),
    video: video.map((row) => row.id),
  };
}
