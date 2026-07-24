import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, inArray, schema, type Database } from '@bmas/db';
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

    try {
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
    } catch (error) {
      // The row is committed but no worker will ever pick it up (e.g. Redis
      // was unreachable). Left in place, the idempotency check would return
      // this dead 'queued' row forever and never re-enqueue. Removing it lets
      // the client retry cleanly.
      await this.db.delete(schema.generationJobs).where(eq(schema.generationJobs.id, job.id));
      throw error;
    }

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

  /** Generation history per brand (FR-5.2). The controller clamps `limit`;
   *  this guard keeps a bad value from reaching Postgres if called elsewhere.
   *  Joined with the product name and the earliest asset per job (signed) so
   *  the client can render a thumbnail grid without an N+1 `findOne` per row. */
  async listByBrand(brandId: string, limit = 20) {
    const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const jobs = await this.db
      .select({
        id: schema.generationJobs.id,
        status: schema.generationJobs.status,
        stage: schema.generationJobs.stage,
        campaignType: schema.generationJobs.campaignType,
        styleTemplate: schema.generationJobs.styleTemplate,
        outputFormat: schema.generationJobs.outputFormat,
        error: schema.generationJobs.error,
        createdAt: schema.generationJobs.createdAt,
        productName: schema.products.name,
      })
      .from(schema.generationJobs)
      .leftJoin(schema.products, eq(schema.generationJobs.productId, schema.products.id))
      .where(eq(schema.generationJobs.brandId, brandId))
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(bounded);

    if (jobs.length === 0) return [];

    // Ordered ascending so the first row seen per jobId in the Map below is
    // the earliest asset, matching the "Version 1" thumbnail shown in gallery.
    const assets = await this.db
      .select({
        jobId: schema.creativeAssets.jobId,
        storageKey: schema.creativeAssets.storageKey,
      })
      .from(schema.creativeAssets)
      .where(inArray(schema.creativeAssets.jobId, jobs.map((job) => job.id)))
      .orderBy(schema.creativeAssets.createdAt);

    const thumbnailByJob = new Map<string, string>();
    for (const asset of assets) {
      if (!thumbnailByJob.has(asset.jobId)) thumbnailByJob.set(asset.jobId, asset.storageKey);
    }

    return Promise.all(
      jobs.map(async (job) => {
        const storageKey = thumbnailByJob.get(job.id);
        return { ...job, thumbnailUrl: storageKey ? await this.assetUrls.sign(storageKey) : null };
      }),
    );
  }
}
