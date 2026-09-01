import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, inArray, recordFeedbackSignal, schema, type Database } from '@bmas/db';
import { QUEUES, type CreativeRequest } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { AssetUrls } from '../core/asset-urls.js';
import { ASSET_URLS, CONTENT_EDIT_QUEUE, DATABASE, GENERATION_QUEUE } from '../core/core.module.js';

/** FR-3.3: at most this many regenerations per image slot — a capped,
 *  user-facing budget, counted against attempts (including failed ones,
 *  which still cost a provider call) rather than only successes. */
const MAX_REGENERATIONS = 2;

@Injectable()
export class GenerationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GENERATION_QUEUE) private readonly queue: Queue,
    @Inject(CONTENT_EDIT_QUEUE) private readonly editQueue: Queue,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
  ) {}

  /**
   * Accepts a request, persists it, and hands off to the worker. Returns
   * immediately — generation takes up to two minutes, so the client polls
   * `findOne` (or subscribes to progress) rather than blocking on the response.
   *
   * `delayMs` lets a caller queue the work for later without changing when the
   * job appears in the database — a scheduled campaign inserts the row (and
   * lets the client see it as 'queued') immediately, but doesn't want the
   * worker to actually start generating hours before the post is due.
   */
  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
  }

  async enqueue(
    request: CreativeRequest,
    idempotencyKey: string,
    ownerId: string,
    opts: { delayMs?: number } = {},
  ) {
    await this.assertBrandOwned(request.brandId, ownerId);

    const existing = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    // A retried request must not double-charge credits or double-call a provider.
    if (existing[0]) return existing[0];

    // Validated here rather than left to the foreign keys. A bad id would
    // otherwise surface as a constraint violation and a 500, and a product
    // belonging to another brand would enqueue happily and fail deep in the
    // worker, minutes later, after the client has already been told 'queued'.
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
          ...(opts.delayMs ? { delay: opts.delayMs } : {}),
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

  /**
   * Stops a generation the user no longer wants.
   *
   * Two halves, because a job can be in either place: the queued BullMQ job is
   * removed so it never starts, and the row is flipped to `cancelled` so a run
   * already in flight sees it at its next stage boundary and stops there. A
   * provider call already open cannot be recalled — the stage it is in is paid
   * for either way — but the stages after it are not.
   */
  async cancel(jobId: string, ownerId: string) {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);
    if (!job) throw new NotFoundException(`Generation job ${jobId} not found`);
    await this.assertBrandOwned(job.brandId, ownerId);

    if (job.status === 'succeeded' || job.status === 'failed') {
      throw new BadRequestException(`This generation already ${job.status}.`);
    }
    if (job.status === 'cancelled') return job;

    // The BullMQ job id is the idempotency key (see `enqueue`). Removing a job
    // that has already started throws rather than stopping it, which is exactly
    // the case the status flag below covers.
    const queued = await this.queue.getJob(job.idempotencyKey);
    await queued?.remove().catch(() => undefined);

    const [updated] = await this.db
      .update(schema.generationJobs)
      .set({ status: 'cancelled', stage: null, finishedAt: new Date() })
      .where(eq(schema.generationJobs.id, jobId))
      .returning();
    if (!updated) throw new Error('Update returned no row');
    return updated;
  }

  async findOne(jobId: string, ownerId: string) {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);

    if (!job) throw new NotFoundException(`Generation job ${jobId} not found`);
    await this.assertBrandOwned(job.brandId, ownerId);

    const [assets, copy] = await Promise.all([
      // Ordered so a slot's originals consistently appear before its edits,
      // and the gallery's index-based "Version N" fallback (uniform-mode jobs
      // with no `variantKind`) doesn't reshuffle across polls — Postgres makes
      // no ordering guarantee on an unordered select.
      this.db
        .select()
        .from(schema.creativeAssets)
        .where(eq(schema.creativeAssets.jobId, jobId))
        .orderBy(schema.creativeAssets.createdAt),
      this.db.select().from(schema.copyPacks).where(eq(schema.copyPacks.jobId, jobId)),
    ]);

    // Every root this job's assets belong to (an asset that's itself a root
    // counts as its own) — what the client needs to know which slot each
    // in-flight/failed edit attempt belongs to and how many it has left.
    const roots = [...new Set(assets.map((asset) => asset.rootAssetId ?? asset.id))];
    const assetEdits = roots.length
      ? await this.db
          .select()
          .from(schema.assetEdits)
          .where(inArray(schema.assetEdits.rootAssetId, roots))
      : [];

    // Clients get a URL they can load directly; `storageKey` alone is unusable
    // outside the cluster. Signed per request rather than stored, so the link
    // expires and the bucket can stay private.
    return { ...job, assets: await this.assetUrls.signAll(assets), copy, assetEdits };
  }

  /**
   * FR-3.3: a targeted edit of one asset, not a rerun of the pipeline. Queues
   * a single `.edit()` call on `apps/content-worker/src/pipeline/asset-edit.ts`
   * against whichever image is currently the slot's tip — `sourceAssetId` on
   * the inserted row, not necessarily `assetId` itself if the caller passed
   * one that's already been superseded, though in practice the client always
   * points at the current tip.
   */
  async regenerateAsset(jobId: string, assetId: string, ownerId: string, instruction: string) {
    const [asset] = await this.db
      .select()
      .from(schema.creativeAssets)
      .where(eq(schema.creativeAssets.id, assetId))
      .limit(1);
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    // Ownership alone isn't enough: an owner with two generations could pass
    // a (jobId, assetId) pair spanning both, both individually theirs but not
    // actually related — this catches that before it produces a chain whose
    // root doesn't belong to the job the client thinks it's nested under.
    if (asset.jobId !== jobId) {
      throw new BadRequestException(`Asset ${assetId} does not belong to generation ${jobId}`);
    }

    const [job] = await this.db
      .select({ brandId: schema.generationJobs.brandId })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);
    if (!job) throw new NotFoundException(`Generation job ${jobId} not found`);
    await this.assertBrandOwned(job.brandId, ownerId);

    const root = asset.rootAssetId ?? asset.id;

    const attempts = await this.db
      .select({ status: schema.assetEdits.status })
      .from(schema.assetEdits)
      .where(eq(schema.assetEdits.rootAssetId, root));

    if (attempts.some((attempt) => attempt.status === 'queued' || attempt.status === 'running')) {
      throw new BadRequestException('This image is already being regenerated.');
    }
    if (attempts.length >= MAX_REGENERATIONS) {
      throw new BadRequestException(
        `This image has already been regenerated the maximum of ${MAX_REGENERATIONS} times.`,
      );
    }

    let edit: typeof schema.assetEdits.$inferSelect;
    try {
      const [inserted] = await this.db
        .insert(schema.assetEdits)
        .values({ rootAssetId: root, sourceAssetId: asset.id, instruction })
        .returning();
      if (!inserted) throw new Error('Insert returned no row');
      edit = inserted;
    } catch (error) {
      // `asset_edits_one_active_per_root_idx` (partial unique on rootAssetId
      // WHERE status IN queued/running) is the real enforcement for the
      // "already being regenerated" rule above — the read-then-insert check
      // a few lines up is only a fast path that closes the race when two
      // regenerate requests for the same slot land close enough together to
      // both pass it. Postgres error code 23505 is unique_violation; Drizzle
      // wraps the driver's error rather than exposing `.code` directly, so
      // it has to be read off `.cause` (confirmed against a live 23505 from
      // `postgres`, not assumed from the driver's types).
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') {
        throw new BadRequestException('This image is already being regenerated.');
      }
      throw error;
    }

    try {
      await this.editQueue.add(
        QUEUES.contentEdit,
        { editId: edit.id },
        {
          jobId: edit.id,
          // A capped, user-facing budget — an automatic retry would silently
          // spend one of the user's regenerations without them asking twice.
          attempts: 1,
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      );
      // Brand Memory. The most directly useful signal the platform collects:
      // the user has stated, in their own words, what was wrong with an image
      // we showed them. Recorded only once the edit is genuinely queued — an
      // instruction whose job failed to enqueue was never acted on, and the
      // row is deleted below.
      await recordFeedbackSignal(this.db, {
        brandId: job.brandId,
        kind: 'regenerated',
        summary: `The user asked for this correction on a generated creative: "${instruction.slice(0, 200)}"`,
        detail: { assetId: asset.id, rootAssetId: root, jobId },
      });
    } catch (error) {
      await this.db.delete(schema.assetEdits).where(eq(schema.assetEdits.id, edit.id));
      throw error;
    }

    return edit;
  }

  /** Generation history per brand (FR-5.2). The controller clamps `limit`;
   *  this guard keeps a bad value from reaching Postgres if called elsewhere.
   *  Joined with the product name and the earliest asset per job (signed) so
   *  the client can render a thumbnail grid without an N+1 `findOne` per row. */
  async listByBrand(brandId: string, ownerId: string, limit = 20) {
    await this.assertBrandOwned(brandId, ownerId);
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
        thumbnailStorageKey: schema.creativeAssets.thumbnailStorageKey,
      })
      .from(schema.creativeAssets)
      .where(
        inArray(
          schema.creativeAssets.jobId,
          jobs.map((job) => job.id),
        ),
      )
      .orderBy(schema.creativeAssets.createdAt);

    const thumbnailByJob = new Map<string, string>();
    for (const asset of assets) {
      // The real thumbnail when one exists; assets generated before thumbnailing
      // fall back to the full-size key so the grid still renders.
      if (!thumbnailByJob.has(asset.jobId)) {
        thumbnailByJob.set(asset.jobId, asset.thumbnailStorageKey ?? asset.storageKey);
      }
    }

    return Promise.all(
      jobs.map(async (job) => {
        const storageKey = thumbnailByJob.get(job.id);
        return { ...job, thumbnailUrl: storageKey ? await this.assetUrls.sign(storageKey) : null };
      }),
    );
  }
}
