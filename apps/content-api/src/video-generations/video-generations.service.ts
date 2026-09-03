import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  asc,
  desc,
  eq,
  inArray,
  reapStalledVideoGenerationJob,
  schema,
  type Database,
} from '@bmas/db';
import { QUEUES, type VideoGenerationRequest } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { AssetUrls } from '../core/asset-urls.js';
import { ASSET_URLS, DATABASE, VIDEO_GENERATION_QUEUE } from '../core/core.module.js';

/**
 * Video generation's own service — mirrors `GenerationsService.enqueue`/
 * `findOne` (idempotency, ownership checks, dead-row cleanup on a failed
 * enqueue) but nothing past that: no `cancel`, no `regenerateAsset`. Video has
 * no asset-edit concept yet, and a cancel button is a UI affordance this
 * feature doesn't have a screen to hang it on. Add them the day either does.
 */
@Injectable()
export class VideoGenerationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(VIDEO_GENERATION_QUEUE) private readonly queue: Queue,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
  ) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
  }

  async enqueue(request: VideoGenerationRequest, idempotencyKey: string, ownerId: string) {
    await this.assertBrandOwned(request.brandId, ownerId);

    const existing = await this.db
      .select()
      .from(schema.videoGenerationJobs)
      .where(eq(schema.videoGenerationJobs.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing[0]) return existing[0];

    // Validated here rather than left to the foreign key, same reasoning
    // GenerationsService.enqueue gives for the identical check on images: a
    // bad id would otherwise surface as a constraint violation deep in the
    // worker, minutes after the client was already told 'queued'.
    const [product] = await this.db
      .select({ brandId: schema.products.brandId })
      .from(schema.products)
      .where(eq(schema.products.id, request.productId))
      .limit(1);
    if (!product) throw new NotFoundException(`Product ${request.productId} not found`);
    if (product.brandId !== request.brandId) {
      throw new BadRequestException(
        `Product ${request.productId} does not belong to brand ${request.brandId}`,
      );
    }

    const [job] = await this.db
      .insert(schema.videoGenerationJobs)
      .values({
        brandId: request.brandId,
        productId: request.productId,
        idempotencyKey,
        request,
      })
      .returning();
    if (!job) throw new Error('Insert returned no row');

    try {
      await this.queue.add(
        QUEUES.videoGeneration,
        { jobId: job.id, brandId: job.brandId, idempotencyKey },
        {
          jobId: idempotencyKey,
          attempts: 2,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
    } catch (error) {
      await this.db
        .delete(schema.videoGenerationJobs)
        .where(eq(schema.videoGenerationJobs.id, job.id));
      throw error;
    }

    return job;
  }

  async findOne(jobId: string, ownerId: string) {
    // See TrendsService.getRun — same reasoning: a run whose worker died
    // mid-job is frozen non-terminal forever otherwise, and the mobile client
    // polls this every 1.5s for up to 420s before giving up with a generic
    // timeout. Reaping first means this same response already carries
    // 'failed' and a real reason. Safe unconditionally — the reaper only
    // touches a row that is both non-terminal and past its timeout.
    await reapStalledVideoGenerationJob(this.db, jobId);

    const [job] = await this.db
      .select()
      .from(schema.videoGenerationJobs)
      .where(eq(schema.videoGenerationJobs.id, jobId))
      .limit(1);
    if (!job) throw new NotFoundException(`Video generation job ${jobId} not found`);
    await this.assertBrandOwned(job.brandId, ownerId);

    const assets = await this.db
      .select()
      .from(schema.videoAssets)
      .where(eq(schema.videoAssets.jobId, jobId))
      .orderBy(schema.videoAssets.createdAt);

    const signed = await Promise.all(
      assets.map(async (asset) => ({
        ...asset,
        url: await this.assetUrls.sign(asset.storageKey),
        thumbnailUrl: asset.thumbnailStorageKey
          ? await this.assetUrls.sign(asset.thumbnailStorageKey)
          : null,
      })),
    );

    return { ...job, assets: signed };
  }

  /**
   * Returns a summary list of video generation jobs for `brandId`, newest-
   * first, limited to `limit` rows.  Mirrors `GenerationsService.list`'s
   * shape and reasoning: a list never needs the full job (no `copy` pack, no
   * every-asset array) — just enough for a history thumbnail row.
   *
   * Each item carries a signed `videoUrl` and `thumbnailUrl` from the first
   * `videoAssets` row for that job (null while still running or if the job
   * failed before storage).
   */
  async listForBrand(
    brandId: string,
    ownerId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      status: string;
      stage: string | null;
      error: string | null;
      createdAt: Date;
      finishedAt: Date | null;
      durationSeconds: number | null;
      productName: string | null;
      videoUrl: string | null;
      thumbnailUrl: string | null;
      copyHeadline: string | null;
    }>
  > {
    await this.assertBrandOwned(brandId, ownerId);

    // Pull all jobs for the brand, newest-first.
    const jobs = await this.db
      .select()
      .from(schema.videoGenerationJobs)
      .where(eq(schema.videoGenerationJobs.brandId, brandId))
      .orderBy(desc(schema.videoGenerationJobs.createdAt))
      .limit(limit);

    if (jobs.length === 0) return [];

    // Fetch the first asset for each job in one query rather than N+1 selects.
    const jobIds = jobs.map((j) => j.id);
    const allAssets = await this.db
      .select()
      .from(schema.videoAssets)
      .where(
        jobIds.length === 1
          ? eq(schema.videoAssets.jobId, jobIds[0]!)
          : inArray(schema.videoAssets.jobId, jobIds),
      )
      .orderBy(asc(schema.videoAssets.createdAt));

    // Group assets by jobId and keep only the first.
    const assetByJob = new Map(
      allAssets.reduce<[string, (typeof allAssets)[0]][]>((acc, asset) => {
        if (!acc.some(([id]) => id === asset.jobId)) acc.push([asset.jobId, asset]);
        return acc;
      }, []),
    );

    // Fetch product names in one query.
    const productIds = [
      ...new Set(jobs.map((j) => j.productId).filter((id): id is string => Boolean(id))),
    ];
    const products =
      productIds.length === 0
        ? []
        : await this.db
            .select({ id: schema.products.id, name: schema.products.name })
            .from(schema.products)
            .where(
              productIds.length === 1
                ? eq(schema.products.id, productIds[0]!)
                : inArray(schema.products.id, productIds),
            );
    const productNameById = new Map(products.map((p) => [p.id, p.name]));

    return Promise.all(
      jobs.map(async (job) => {
        const asset = assetByJob.get(job.id);
        const copy = job.copy as { headline?: string } | null;
        return {
          id: job.id,
          status: job.status,
          stage: job.stage,
          error: job.error,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt ?? null,
          durationSeconds: asset?.durationSeconds ?? null,
          productName: job.productId ? (productNameById.get(job.productId) ?? null) : null,
          videoUrl: asset ? await this.assetUrls.sign(asset.storageKey) : null,
          thumbnailUrl: asset?.thumbnailStorageKey
            ? await this.assetUrls.sign(asset.thumbnailStorageKey)
            : null,
          copyHeadline: copy?.headline ?? null,
        };
      }),
    );
  }
}
