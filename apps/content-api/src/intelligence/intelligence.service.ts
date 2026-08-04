import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, recordFeedbackSignal, schema, type Database } from '@bmas/db';
import { QUEUES, type UpdateIntelligenceItemStatusInput } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { DATABASE, INTELLIGENCE_RESEARCH_QUEUE } from '../core/core.module.js';

/**
 * "Refresh My Intelligence Feed." Same shape as `TrendsService` — this owns
 * intake, ownership checks and reads, the worker
 * (`apps/content-worker/src/pipeline/intelligence-research.ts`) fills in the
 * actual research.
 */
@Injectable()
export class IntelligenceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INTELLIGENCE_RESEARCH_QUEUE) private readonly queue: Queue,
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

  async startResearch(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const [run] = await this.db
      .insert(schema.intelligenceRuns)
      .values({ brandId })
      .returning();
    if (!run) throw new Error('Insert returned no row');

    try {
      await this.queue.add(
        QUEUES.intelligenceResearch,
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
      await this.db.delete(schema.intelligenceRuns).where(eq(schema.intelligenceRuns.id, run.id));
      throw error;
    }

    return run;
  }

  async getRun(runId: string, ownerId: string) {
    const [run] = await this.db
      .select()
      .from(schema.intelligenceRuns)
      .where(eq(schema.intelligenceRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Intelligence research run ${runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    const items = await this.db
      .select()
      .from(schema.intelligenceItems)
      .where(eq(schema.intelligenceItems.runId, runId));

    return { ...run, items: [...items].sort((a, b) => b.score.overall - a.score.overall) };
  }

  private parseLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return 20;
    return Math.min(100, Math.max(1, Math.floor(raw)));
  }

  async listRuns(brandId: string, ownerId: string, limit?: number) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.intelligenceRuns)
      .where(eq(schema.intelligenceRuns.brandId, brandId))
      .orderBy(desc(schema.intelligenceRuns.createdAt))
      .limit(this.parseLimit(limit));
  }

  /**
   * The feed itself: every item from this brand's most recent successful run,
   * newest run only — an older run's items are superseded, not additive, the
   * same "replace rather than append" reasoning the worker applies when it
   * deletes and reinserts a retried run's rows. Optionally narrowed to one
   * category for the UI's tabs.
   */
  async getFeed(brandId: string, ownerId: string, category?: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const [latestRun] = await this.db
      .select({ id: schema.intelligenceRuns.id })
      .from(schema.intelligenceRuns)
      .where(
        and(
          eq(schema.intelligenceRuns.brandId, brandId),
          eq(schema.intelligenceRuns.status, 'succeeded'),
        ),
      )
      .orderBy(desc(schema.intelligenceRuns.createdAt))
      .limit(1);

    if (!latestRun) return [];

    const rows = await this.db
      .select()
      .from(schema.intelligenceItems)
      .where(eq(schema.intelligenceItems.runId, latestRun.id));

    const filtered = category ? rows.filter((row) => row.category === category) : rows;
    return [...filtered].sort((a, b) => b.score.overall - a.score.overall);
  }

  /**
   * Marks what the user did with one lead, and — the point of the exercise —
   * feeds that action back into Brand Memory. A dismissed lead is a rejection
   * of that topic (kind 'rejected', confidence 0.5, standard rejection floor);
   * a saved one is closer to choosing a direction than approving a finished
   * creative, so it borrows 'variant_selected' rather than 'approved', both
   * filed under the 'topic' dimension rather than each kind's own default —
   * see the `type` override on `recordFeedbackSignal`.
   */
  async updateItemStatus(
    itemId: string,
    ownerId: string,
    input: UpdateIntelligenceItemStatusInput,
  ) {
    const [item] = await this.db
      .select()
      .from(schema.intelligenceItems)
      .where(eq(schema.intelligenceItems.id, itemId))
      .limit(1);
    if (!item) throw new NotFoundException(`Intelligence item ${itemId} not found`);

    const [run] = await this.db
      .select({ brandId: schema.intelligenceRuns.brandId })
      .from(schema.intelligenceRuns)
      .where(eq(schema.intelligenceRuns.id, item.runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Intelligence run ${item.runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    const [updated] = await this.db
      .update(schema.intelligenceItems)
      .set({ status: input.status })
      .where(eq(schema.intelligenceItems.id, itemId))
      .returning();
    if (!updated) throw new Error('Update returned no row');

    if (input.status === 'dismissed') {
      await recordFeedbackSignal(this.db, {
        brandId: run.brandId,
        kind: 'rejected',
        type: 'topic',
        summary: `Dismissed as not relevant: "${item.title}"`,
        detail: { category: item.category, intelligenceItemId: item.id },
      });
    } else if (input.status === 'saved') {
      await recordFeedbackSignal(this.db, {
        brandId: run.brandId,
        kind: 'variant_selected',
        type: 'topic',
        summary: `Saved as relevant: "${item.title}"`,
        detail: { category: item.category, intelligenceItemId: item.id },
      });
    }

    return updated;
  }
}
