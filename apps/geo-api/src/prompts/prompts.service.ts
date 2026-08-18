import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, eq, schema, type Database, type TrackedPromptRow } from '@bmas/db';
import { QUEUES, type CreateTrackedPromptInput } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { assertBrandOwned } from '../common/assert-brand-owned.js';
import { loadEnv } from '../config/env.js';
import { DATABASE, PROBE_QUEUE, PROMPT_REFRESH_QUEUE, ROLLUP_QUEUE } from '../core/core.module.js';

/** Long enough for a sweep's probe+analysis jobs to finish before the rollup
 *  reads `probe_runs`; short enough the dashboard updates the same session. */
const ROLLUP_DELAY_MS = 2 * 60_000;

@Injectable()
export class PromptsService {
  private readonly logger = new Logger(PromptsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROBE_QUEUE) private readonly probeQueue: Queue,
    @Inject(ROLLUP_QUEUE) private readonly rollupQueue: Queue,
    @Inject(PROMPT_REFRESH_QUEUE) private readonly promptRefreshQueue: Queue,
  ) {}

  /**
   * The brand's live prompt set.
   *
   * Retired rows are excluded: a refresh deactivates the previous suggested
   * set rather than deleting it (deleting would cascade away the probe history
   * the visibility score is computed from), so without this filter every
   * refresh would make the list longer instead of replacing it.
   */
  async listByBrand(brandId: string, ownerId: string): Promise<TrackedPromptRow[]> {
    await assertBrandOwned(this.db, brandId, ownerId);
    return this.db
      .select()
      .from(schema.trackedPrompts)
      .where(and(eq(schema.trackedPrompts.brandId, brandId), eq(schema.trackedPrompts.isActive, true)))
      .orderBy(schema.trackedPrompts.createdAt);
  }

  async create(input: CreateTrackedPromptInput, ownerId: string): Promise<TrackedPromptRow> {
    await assertBrandOwned(this.db, input.brandId, ownerId);
    const [row] = await this.db
      .insert(schema.trackedPrompts)
      .values({
        brandId: input.brandId,
        text: input.text,
        intent: input.intent,
        locale: input.locale ?? null,
        engines: input.engines,
        isActive: input.isActive,
        // Anything created through this endpoint was typed by a person, so it
        // is never a candidate for replacement by `refresh`. Not caller-supplied:
        // see the omit in `createTrackedPromptSchema`.
        source: 'user',
        ...(input.schedule ? { schedule: input.schedule } : {}),
      })
      .returning();

    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Takes a prompt off the brand's list.
   *
   * How that happens depends on whether the prompt has ever been probed:
   *
   * - **Never probed** — deleted outright. Nothing is lost, and a typo or a
   *   badly-worded question shouldn't leave a permanent tombstone.
   * - **Probed at least once** — retired (`isActive = false`) instead.
   *   `geo.probe_runs.prompt_id` cascades, so deleting would take the runs
   *   with it, and the mentions and visibility snapshots derived from those
   *   runs are what the score on this screen is made of. Removing a question
   *   you no longer want asked should not quietly rewrite your history.
   *
   * Either way it leaves the list, which is what the user asked for. The
   * return says which happened so the client can be honest about it.
   */
  async remove(
    promptId: string,
    ownerId: string,
  ): Promise<{ id: string; deleted: boolean; probeRuns: number }> {
    const [prompt] = await this.db
      .select()
      .from(schema.trackedPrompts)
      .where(eq(schema.trackedPrompts.id, promptId))
      .limit(1);

    if (!prompt) throw new NotFoundException(`Tracked prompt ${promptId} not found`);
    await assertBrandOwned(this.db, prompt.brandId, ownerId);

    const [runs] = await this.db
      .select({ value: count() })
      .from(schema.probeRuns)
      .where(eq(schema.probeRuns.promptId, promptId));
    const probeRuns = runs?.value ?? 0;

    if (probeRuns === 0) {
      await this.db.delete(schema.trackedPrompts).where(eq(schema.trackedPrompts.id, promptId));
      this.logger.log(`Deleted never-probed prompt ${promptId}`);
      return { id: promptId, deleted: true, probeRuns };
    }

    await this.db
      .update(schema.trackedPrompts)
      .set({ isActive: false })
      .where(eq(schema.trackedPrompts.id, promptId));
    this.logger.log(`Retired prompt ${promptId} (${probeRuns} probe run(s) kept)`);
    return { id: promptId, deleted: false, probeRuns };
  }

  /**
   * Regenerates the brand's suggested prompts, leaving user-added ones alone.
   *
   * Queued rather than done here: it is a model call, and in this system model
   * calls belong to workers. The client polls `listByBrand` and treats the
   * refresh as finished once a suggested prompt newer than `requestedAt`
   * appears — no status table for a job whose only output is rows.
   *
   * The job id pins one in-flight refresh per brand per minute, so an impatient
   * double-tap collapses into a single generation instead of billing twice and
   * racing two writers.
   */
  async refreshSuggested(brandId: string, ownerId: string): Promise<{ requestedAt: string }> {
    await assertBrandOwned(this.db, brandId, ownerId);

    const requestedAt = new Date();
    await this.promptRefreshQueue.add(
      QUEUES.geoPromptRefresh,
      { brandId, requestedAt },
      {
        // Minute granularity, colons stripped — BullMQ rejects ':' in a custom
        // job id, and an ISO timestamp is full of them.
        jobId: `${brandId}-${requestedAt.toISOString().slice(0, 16).replace(/:/g, '')}`,
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );

    this.logger.log(`Queued prompt refresh for brand ${brandId}`);
    return { requestedAt: requestedAt.toISOString() };
  }

  /**
   * Fans out one job per (prompt, engine) rather than one job per prompt, so a
   * single slow or rate-limited engine can't stall the rest of the sweep.
   */
  async enqueueProbe(promptId: string, ownerId: string): Promise<{ enqueued: number }> {
    const [prompt] = await this.db
      .select()
      .from(schema.trackedPrompts)
      .where(eq(schema.trackedPrompts.id, promptId))
      .limit(1);

    if (!prompt) throw new NotFoundException(`Tracked prompt ${promptId} not found`);
    await assertBrandOwned(this.db, prompt.brandId, ownerId);

    await this.probeQueue.addBulk(
      prompt.engines.map((engine) => ({
        name: QUEUES.geoProbe,
        data: { promptId: prompt.id, brandId: prompt.brandId, engine },
        opts: {
          // One run per prompt/engine/hour — reruns of the same sweep are free.
          jobId: `${prompt.id}-${engine}-${new Date().toISOString().slice(0, 13)}`,
          attempts: 3,
          backoff: { type: 'exponential' as const, delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      })),
    );

    // The worker's cron also enqueues roll-ups, but only on its own schedule —
    // without this, a manual probe wouldn't move the dashboard until the next
    // tick. The window MUST match the worker's (`GEO_ROLLUP_WINDOW_DAYS`): the
    // dashboard shows whichever snapshot has the newest `period_start`, so a
    // shorter window here would win every time and pin the headline score to a
    // single sweep — one prompt that happened not to name the brand would read
    // as a score of zero.
    //
    // `periodEnd` is set to when the delayed job will actually RUN, not to
    // now — `runRollup` filters on `probe_runs.run_at <= periodEnd`, and the
    // probes this call just queued haven't run yet, so a `periodEnd` of "now"
    // excludes every one of them once the delay elapses. That silently
    // defeated the whole point of this block: the probe that triggered the
    // rollup would never be the one that moved the dashboard.
    const periodEnd = new Date(Date.now() + ROLLUP_DELAY_MS);
    const periodStart = new Date(
      periodEnd.getTime() - loadEnv().GEO_ROLLUP_WINDOW_DAYS * 24 * 60 * 60_000,
    );
    await this.rollupQueue.add(
      QUEUES.geoRollup,
      { brandId: prompt.brandId, periodStart, periodEnd },
      { delay: ROLLUP_DELAY_MS, removeOnComplete: 100, removeOnFail: 100 },
    );

    this.logger.log(`Enqueued ${prompt.engines.length} probes for prompt ${prompt.id}`);
    return { enqueued: prompt.engines.length };
  }
}
