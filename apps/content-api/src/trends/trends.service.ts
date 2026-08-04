import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, recordFeedbackSignal, schema, type Database } from '@bmas/db';
import {
  QUEUES,
  type RequestTrendResearchInput,
  type ScheduleTrendOpportunityInput,
  type UpdateTrendOpportunityStatusInput,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import { DATABASE, TREND_RESEARCH_QUEUE } from '../core/core.module.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';

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
    private readonly scheduling: SchedulingService,
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

  /** One run plus its opportunities, ranked. Sorted here rather than with a
   *  jsonb-path ORDER BY — a run produces at most 8 opportunities, nowhere
   *  near enough rows to need a database-side sort or the raw-SQL
   *  expression index it would take to put one on a jsonb field. */
  async getRun(runId: string, ownerId: string) {
    const [run] = await this.db
      .select()
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Trend research run ${runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    const opportunities = await this.db
      .select()
      .from(schema.trendOpportunities)
      .where(eq(schema.trendOpportunities.runId, runId));

    return {
      ...run,
      opportunities: [...opportunities].sort((a, b) => b.score.overall - a.score.overall),
    };
  }

  /** The raw evidence layer for one run — every signal collected, whether or
   *  not it was clustered into a surfaced opportunity. Separate from
   *  `getRun` rather than folded in: most callers (the trend feed screen)
   *  only need opportunities, and a run can carry dozens of signals across
   *  several providers, payload worth skipping by default. Exists for
   *  transparency — "why did the platform think this mattered" should be
   *  answerable down to the actual search results, not just the model's
   *  summary of them. */
  async getSignals(runId: string, ownerId: string) {
    const [run] = await this.db
      .select({ brandId: schema.trendResearchRuns.brandId })
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Trend research run ${runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    return this.db
      .select()
      .from(schema.trendSignals)
      .where(eq(schema.trendSignals.runId, runId));
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

  /**
   * The other half of "connect trends data and research to the brand's
   * context window": every action the user takes on an opportunity — Work On
   * This, Save, Ignore — now writes back into `brand_preferences`, not just
   * this row's `status`. Before this, `getTrendContext`'s `recentTopics` only
   * ever told the next research run *what was suggested*; nothing told it
   * what the brand actually *wanted*. `ignored` maps to a rejection of that
   * topic (kind 'rejected', 0.5 confidence — the same floor a content
   * rejection gets); `working_on`/`saved` map to 'variant_selected' —
   * choosing a direction, not approving a finished creative, so it does not
   * borrow 'approved''s weaker, prompt-suppressed confidence. Both are filed
   * under the 'topic' dimension via the `type` override, regardless of which
   * kind they borrow their confidence from.
   */
  async updateOpportunityStatus(
    opportunityId: string,
    ownerId: string,
    input: UpdateTrendOpportunityStatusInput,
  ) {
    const [opportunity] = await this.db
      .select()
      .from(schema.trendOpportunities)
      .where(eq(schema.trendOpportunities.id, opportunityId))
      .limit(1);
    if (!opportunity) throw new NotFoundException(`Trend opportunity ${opportunityId} not found`);

    const [run] = await this.db
      .select({ brandId: schema.trendResearchRuns.brandId })
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.id, opportunity.runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Trend research run ${opportunity.runId} not found`);
    await this.assertBrandOwned(run.brandId, ownerId);

    const [updated] = await this.db
      .update(schema.trendOpportunities)
      .set({ status: input.status })
      .where(eq(schema.trendOpportunities.id, opportunityId))
      .returning();
    if (!updated) throw new Error('Update returned no row');

    if (input.status === 'ignored') {
      await recordFeedbackSignal(this.db, {
        brandId: run.brandId,
        kind: 'rejected',
        type: 'topic',
        summary: `Ignored as not relevant: "${opportunity.title}"`,
        detail: { category: opportunity.category, trendOpportunityId: opportunity.id },
      });
    } else {
      await recordFeedbackSignal(this.db, {
        brandId: run.brandId,
        kind: 'variant_selected',
        type: 'topic',
        summary: `Chose to act on: "${opportunity.title}"`,
        detail: {
          category: opportunity.category,
          trendOpportunityId: opportunity.id,
          status: input.status,
        },
      });
    }

    return updated;
  }

  /**
   * "Schedule for Approval" — the second destination for an opportunity,
   * alongside `updateOpportunityStatus`'s existing 'working_on' path that the
   * one-shot /create screen uses. Creates a single-post scheduled campaign
   * from the opportunity's `suggestedRequest`, so a high-opportunity signal
   * can flow into the full Trend → Content → QA → Scheduling → Publishing
   * chain rather than stopping at instant generation.
   *
   * Delegates campaign creation to `SchedulingService.createCampaign`
   * entirely — ownership check, product validation, slot computation and the
   * generation job it enqueues are all that service's existing logic. This
   * method's only job is translating an opportunity into that call's input
   * and recording the same brand-memory signal `updateOpportunityStatus`
   * already records for 'working_on'.
   */
  async scheduleOpportunity(
    opportunityId: string,
    ownerId: string,
    input: ScheduleTrendOpportunityInput,
  ) {
    const [opportunity] = await this.db
      .select()
      .from(schema.trendOpportunities)
      .where(eq(schema.trendOpportunities.id, opportunityId))
      .limit(1);
    if (!opportunity) throw new NotFoundException(`Trend opportunity ${opportunityId} not found`);

    const [run] = await this.db
      .select({ brandId: schema.trendResearchRuns.brandId })
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.id, opportunity.runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Trend research run ${opportunity.runId} not found`);
    // SchedulingService.createCampaign re-checks ownership itself; this call
    // does not skip a check, it just fails at the right layer if this ever
    // stops being true.
    await this.assertBrandOwned(run.brandId, ownerId);

    const campaign = await this.scheduling.createCampaign(run.brandId, ownerId, {
      productId: input.productId,
      campaignType: opportunity.suggestedRequest.campaignType,
      styleTemplate: opportunity.suggestedRequest.styleTemplate,
      outputFormat: opportunity.suggestedRequest.outputFormat,
      totalDays: 1,
      postsPerDay: 1,
    });

    const [updated] = await this.db
      .update(schema.trendOpportunities)
      .set({ status: 'working_on' })
      .where(eq(schema.trendOpportunities.id, opportunityId))
      .returning();

    await recordFeedbackSignal(this.db, {
      brandId: run.brandId,
      kind: 'variant_selected',
      type: 'topic',
      summary: `Chose to schedule for approval: "${opportunity.title}"`,
      detail: {
        category: opportunity.category,
        trendOpportunityId: opportunity.id,
        scheduledCampaignId: campaign.id,
      },
    });

    return { opportunity: updated ?? opportunity, campaign };
  }
}
