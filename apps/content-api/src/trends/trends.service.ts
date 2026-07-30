import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, schema, type Database } from '@bmas/db';
import { QUEUES, type RequestTrendResearchInput } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { DATABASE, TREND_RESEARCH_QUEUE } from '../core/core.module.js';

/**
 * "Find Trending Content Ideas." Enqueues a research run for the worker
 * (`apps/content-worker/src/pipeline/trend-research.ts`) to fill in; this
 * service only owns intake, ownership checks, and reads.
 */
@Injectable()
export class TrendsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TREND_RESEARCH_QUEUE) private readonly queue: Queue,
  ) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) {
      throw new ForbiddenException('This brand belongs to another account.');
    }
  }

  /** Inserts the run row, then enqueues it. Symmetric with GenerationsService:
   *  a queue failure deletes the row rather than leaving a 'queued' run no
   *  worker will ever pick up. */
  async startResearch(brandId: string, ownerId: string, input: RequestTrendResearchInput) {
    await this.assertBrandOwned(brandId, ownerId);

    const [run] = await this.db
      .insert(schema.trendResearchRuns)
      .values({
        brandId,
        locationOverride: input.locationOverride ?? null,
        focus: input.focus ?? null,
      })
      .returning();
    if (!run) throw new Error('Insert returned no row');

    try {
      await this.queue.add(
        QUEUES.trendResearch,
        { runId: run.id, brandId },
        {
          jobId: run.id,
          attempts: 2,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      await this.db.delete(schema.trendResearchRuns).where(eq(schema.trendResearchRuns.id, run.id));
      throw error;
    }

    return run;
  }

  /** One run plus its ideas, ranked. Sorted here rather than with a jsonb-path
   *  ORDER BY — a run produces at most 8 ideas, nowhere near enough rows to
   *  need a database-side sort or the raw-SQL expression index it would take
   *  to put one on a jsonb field. */
  async getRun(runId: string, ownerId: string) {
    const [run] = await this.db
      .select()
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Trend research run ${runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    const ideas = await this.db
      .select()
      .from(schema.trendIdeas)
      .where(eq(schema.trendIdeas.runId, runId));

    return { ...run, ideas: [...ideas].sort((a, b) => b.score.overall - a.score.overall) };
  }

  /** Bounds the page size the same way GenerationsController does: an
   *  unvalidated limit reaches Postgres as an invalid LIMIT and 500s. */
  private parseLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return 20;
    return Math.min(100, Math.max(1, Math.floor(raw)));
  }

  async listRuns(brandId: string, ownerId: string, limit?: number) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.brandId, brandId))
      .orderBy(desc(schema.trendResearchRuns.createdAt))
      .limit(this.parseLimit(limit));
  }
}
