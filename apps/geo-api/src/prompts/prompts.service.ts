import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, schema, type Database, type TrackedPromptRow } from '@bmas/db';
import { QUEUES, type CreateTrackedPromptInput } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { DATABASE, PROBE_QUEUE, ROLLUP_QUEUE } from '../core/core.module.js';

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
  ) {}

  async listByBrand(brandId: string): Promise<TrackedPromptRow[]> {
    return this.db
      .select()
      .from(schema.trackedPrompts)
      .where(eq(schema.trackedPrompts.brandId, brandId));
  }

  async create(input: CreateTrackedPromptInput): Promise<TrackedPromptRow> {
    const [row] = await this.db
      .insert(schema.trackedPrompts)
      .values({
        brandId: input.brandId,
        text: input.text,
        intent: input.intent,
        locale: input.locale ?? null,
        engines: input.engines,
        isActive: input.isActive,
        ...(input.schedule ? { schedule: input.schedule } : {}),
      })
      .returning();

    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Fans out one job per (prompt, engine) rather than one job per prompt, so a
   * single slow or rate-limited engine can't stall the rest of the sweep.
   */
  async enqueueProbe(promptId: string): Promise<{ enqueued: number }> {
    const [prompt] = await this.db
      .select()
      .from(schema.trackedPrompts)
      .where(eq(schema.trackedPrompts.id, promptId))
      .limit(1);

    if (!prompt) throw new Error(`Tracked prompt ${promptId} not found`);

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
    const periodEnd = new Date();
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
