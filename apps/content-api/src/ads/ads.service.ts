import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, schema, type Database } from '@bmas/db';
import { QUEUES, type AdCampaignDto } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { AD_OPTIMIZATION_QUEUE, DATABASE } from '../core/core.module.js';

@Injectable()
export class AdsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AD_OPTIMIZATION_QUEUE) private readonly adQueue: Queue,
  ) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand || brand.ownerId !== ownerId) {
      throw new NotFoundException(`Brand ${brandId} not found`);
    }
  }

  /**
   * Fetches all cross-platform ad campaigns for the brand with aggregated metrics.
   */
  async listCampaigns(brandId: string | undefined, ownerId: string) {
    if (!brandId) {
      throw new BadRequestException('brandId query parameter is required');
    }
    await this.assertBrandOwned(brandId, ownerId);

    const rows = await this.db
      .select()
      .from(schema.adCampaigns)
      .where(eq(schema.adCampaigns.brandId, brandId))
      .orderBy(desc(schema.adCampaigns.spendToDate));

    let totalSpend = 0;
    let totalDailyBudget = 0;
    let totalRoasWeight = 0;

    const platformBreakdown: Record<
      string,
      { count: number; spend: number; dailyBudget: number; roas: number }
    > = {
      google: { count: 0, spend: 0, dailyBudget: 0, roas: 0 },
      meta: { count: 0, spend: 0, dailyBudget: 0, roas: 0 },
      x: { count: 0, spend: 0, dailyBudget: 0, roas: 0 },
    };

    for (const c of rows) {
      totalSpend += c.spendToDate;
      totalDailyBudget += c.dailyBudget;
      totalRoasWeight += c.roas * (c.spendToDate || 1);

      const p = platformBreakdown[c.platform] ?? {
        count: 0,
        spend: 0,
        dailyBudget: 0,
        roas: 0,
      };
      p.count += 1;
      p.spend += c.spendToDate;
      p.dailyBudget += c.dailyBudget;
      p.roas = p.count > 0 ? (p.roas * (p.count - 1) + c.roas) / p.count : c.roas;
      platformBreakdown[c.platform] = p;
    }

    const blendedRoas = totalSpend > 0 ? totalRoasWeight / totalSpend : rows.length > 0 ? rows.reduce((acc, c) => acc + c.roas, 0) / rows.length : 0;

    return {
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalDailyBudget: Math.round(totalDailyBudget * 100) / 100,
      blendedRoas: Math.round(blendedRoas * 100) / 100,
      platformBreakdown,
      campaigns: rows as AdCampaignDto[],
    };
  }

  /**
   * Fetches AI optimization suggestions for the brand.
   */
  async listOptimizations(brandId: string | undefined, ownerId: string, status?: string) {
    if (!brandId) {
      throw new BadRequestException('brandId query parameter is required');
    }
    await this.assertBrandOwned(brandId, ownerId);

    const baseQuery = this.db
      .select({
        id: schema.adOptimizations.id,
        brandId: schema.adOptimizations.brandId,
        campaignId: schema.adOptimizations.campaignId,
        campaignName: schema.adCampaigns.campaignName,
        platform: schema.adCampaigns.platform,
        suggestionType: schema.adOptimizations.suggestionType,
        reasoning: schema.adOptimizations.reasoning,
        status: schema.adOptimizations.status,
        actionPayload: schema.adOptimizations.actionPayload,
        impactEstimate: schema.adOptimizations.impactEstimate,
        createdAt: schema.adOptimizations.createdAt,
        appliedAt: schema.adOptimizations.appliedAt,
      })
      .from(schema.adOptimizations)
      .leftJoin(schema.adCampaigns, eq(schema.adOptimizations.campaignId, schema.adCampaigns.id))
      .where(
        status
          ? and(
              eq(schema.adOptimizations.brandId, brandId),
              eq(schema.adOptimizations.status, status),
            )
          : eq(schema.adOptimizations.brandId, brandId),
      )
      .orderBy(desc(schema.adOptimizations.createdAt));

    const rows = await baseQuery;
    return rows;
  }

  /**
   * Applies an AI optimization recommendation.
   */
  async applyOptimization(id: string, ownerId: string) {
    const [opt] = await this.db
      .select()
      .from(schema.adOptimizations)
      .where(eq(schema.adOptimizations.id, id))
      .limit(1);

    if (!opt) {
      throw new NotFoundException(`Optimization suggestion ${id} not found`);
    }
    await this.assertBrandOwned(opt.brandId, ownerId);

    const now = new Date();
    const [updated] = await this.db
      .update(schema.adOptimizations)
      .set({ status: 'applied', appliedAt: now })
      .where(eq(schema.adOptimizations.id, id))
      .returning();

    return updated;
  }

  /**
   * Dismisses an AI optimization recommendation.
   */
  async dismissOptimization(id: string, ownerId: string) {
    const [opt] = await this.db
      .select()
      .from(schema.adOptimizations)
      .where(eq(schema.adOptimizations.id, id))
      .limit(1);

    if (!opt) {
      throw new NotFoundException(`Optimization suggestion ${id} not found`);
    }
    await this.assertBrandOwned(opt.brandId, ownerId);

    const [updated] = await this.db
      .update(schema.adOptimizations)
      .set({ status: 'dismissed' })
      .where(eq(schema.adOptimizations.id, id))
      .returning();

    return updated;
  }

  /**
   * Enqueues an on-demand ad optimization analysis run.
   */
  async triggerOptimization(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const job = await this.adQueue.add(
      QUEUES.adOptimization,
      { brandId, trigger: 'manual' },
      { attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );

    return {
      status: 'queued',
      jobId: job.id,
      brandId,
    };
  }
}
