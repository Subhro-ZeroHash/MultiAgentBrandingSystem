import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, schema, type Database } from '@bmas/db';
import { QUEUES, type CreativeRequest } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { AssetUrls } from '../core/asset-urls.js';
import { ASSET_URLS, DATABASE, GENERATION_QUEUE } from '../core/core.module.js';

@Injectable()
export class GenerationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GENERATION_QUEUE) private readonly queue: Queue,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
  ) {}

  /**
   * Accepts a request, persists it, and hands off to the worker. Returns
   * immediately — generation takes up to two minutes, so the client polls
   * `findOne` (or subscribes to progress) rather than blocking on the response.
   */
  async enqueue(request: CreativeRequest, idempotencyKey: string) {
    const existing = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    // A retried request must not double-charge credits or double-call a provider.
    if (existing[0]) return existing[0];

    const [job] = await this.db
      .insert(schema.generationJobs)
      .values({
        brandId: request.brandId,
        productId: request.productId,
        idempotencyKey,
        campaignType: request.campaignType,
        styleTemplate: request.styleTemplate,
        outputFormat: request.outputFormat,
        request,
      })
      .returning();

    if (!job) throw new Error('Insert returned no row');

    await this.queue.add(
      QUEUES.contentGeneration,
      { jobId: job.id, brandId: job.brandId, idempotencyKey },
      {
        jobId: idempotencyKey,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    return job;
  }

  async findOne(jobId: string) {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);

    if (!job) throw new NotFoundException(`Generation job ${jobId} not found`);

    const [assets, copy] = await Promise.all([
      this.db.select().from(schema.creativeAssets).where(eq(schema.creativeAssets.jobId, jobId)),
      this.db.select().from(schema.copyPacks).where(eq(schema.copyPacks.jobId, jobId)),
    ]);

    // Clients get a URL they can load directly; `storageKey` alone is unusable
    // outside the cluster. Signed per request rather than stored, so the link
    // expires and the bucket can stay private.
    return { ...job, assets: await this.assetUrls.signAll(assets), copy };
  }

  /** Generation history per brand (FR-5.2). */
  async listByBrand(brandId: string, limit = 20) {
    return this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.brandId, brandId))
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(limit);
  }
}
