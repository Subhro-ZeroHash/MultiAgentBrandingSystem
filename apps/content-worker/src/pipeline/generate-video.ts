import { describeError, isPermanentFailure, withRetry, withTimeout } from '@bmas/ai';
import { and, eq, ne, schema, sql } from '@bmas/db';
import type { CostEvent, VideoGenerationJob, VideoGenerationRequest } from '@bmas/shared';
import { UnrecoverableError } from 'bullmq';
import type { WorkerContext } from '../context.js';
import { mediaTypeFor } from './stages.js';

/**
 * Video generation's own pipeline, mirroring `generate.ts`'s shape at the
 * scale video actually needs: stage tracking, a cancellation checkpoint
 * between stages, and permanent-vs-retryable failure classification are all
 * reused verbatim in spirit. What doesn't carry over is image-specific:
 * diverse-mode fan-out (three knowledge sources have no video equivalent yet)
 * and vision-QA readback (no provider here can read text off a rendered
 * frame the way `analyzeImage` does for a poster). QA for video is a real
 * check, just a smaller one — see `validateVideo` below.
 */

const VIDEO_TIMEOUT_MS = 900_000;

/** See `GenerationCancelledError` in generate.ts — same reasoning. */
class VideoGenerationCancelledError extends Error {
  constructor(jobId: string) {
    super(`Video generation ${jobId} was cancelled`);
    this.name = 'VideoGenerationCancelledError';
  }
}

async function recordCost(ctx: WorkerContext, brandId: string, jobId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: jobId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    videoSeconds: cost.videoSeconds ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

/**
 * The product's primary photo, as a video conditioning frame — LTX's
 * `image_uri` takes exactly one image, so only the primary photo is used
 * (never every product photo the way image generation conditions on all of
 * them). Best-effort: a product with no photos, or a request naming no
 * product at all, generates text-to-video rather than failing the job — the
 * same "a missing reference is a degraded creative, not a failed one"
 * reasoning `loadBrandReferences` uses for images.
 */
async function loadFirstFrame(
  ctx: WorkerContext,
  jobId: string,
  productId: string | undefined,
): Promise<{ data: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined> {
  if (!productId) return undefined;

  const [row] = await ctx.db
    .select()
    .from(schema.productImages)
    .where(and(eq(schema.productImages.productId, productId), eq(schema.productImages.isPrimary, true)))
    .limit(1);
  if (!row) return undefined;

  try {
    const key = row.cleanedStorageKey ?? row.storageKey;
    return { data: await ctx.storage.get(key), mediaType: mediaTypeFor(key) };
  } catch (error) {
    console.warn(
      `[content:video] job ${jobId}: could not load product ${productId}'s primary photo, generating text-to-video instead: ${describeError(error)}`,
    );
    return undefined;
  }
}

/**
 * The real, if smaller, QA check this pipeline stage owes its output — no
 * provider here can read a rendered frame the way `analyzeImage` does for
 * images, so this checks what can be checked without one: the container is
 * actually an MP4 (`ftyp` sits at byte offset 4 in every ISO-BMFF file,
 * whether the provider wrote `isom`, `mp42`, or any other four-character
 * brand), the file isn't empty or truncated, and the reported duration is
 * inside the bounds the request actually asked for. Catches a truncated
 * download or a provider that silently returned something that isn't a
 * video — cheaply, before it ever reaches storage — without pretending to be
 * the content-quality judgement only a real video-QA model could make.
 */
export function validateVideo(data: Buffer, durationSeconds: number, requestedMax: number): void {
  if (data.length < 1024) {
    throw new Error(`video is suspiciously small (${data.length} bytes) — likely a truncated download`);
  }
  const brand = data.subarray(4, 8).toString('ascii');
  if (brand !== 'ftyp') {
    throw new Error(`not a valid MP4 container — expected 'ftyp' at byte 4, got '${brand}'`);
  }
  if (durationSeconds <= 0 || durationSeconds > requestedMax + 1) {
    throw new Error(
      `reported duration ${durationSeconds}s is outside the requested bound (max ${requestedMax}s)`,
    );
  }
}

/** Where this run sits in BullMQ's retry sequence, both 1-based — same shape
 *  as generate.ts's own `AttemptInfo`. */
export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

export async function runVideoGeneration(
  ctx: WorkerContext,
  job: VideoGenerationJob,
  attemptInfo: AttemptInfo = { attempt: 1, maxAttempts: 1 },
): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.id, job.jobId))
    .limit(1);
  if (!row) throw new Error(`Video generation job ${job.jobId} not found`);

  const [brand] = await ctx.db.select().from(schema.brands).where(eq(schema.brands.id, job.brandId)).limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  const request = row.request as unknown as VideoGenerationRequest;

  const setStage = async (stage: string) => {
    const [updated] = await ctx.db
      .update(schema.videoGenerationJobs)
      .set({
        stage,
        status: 'running',
        startedAt: sql`coalesce(${schema.videoGenerationJobs.startedAt}, now())`,
      })
      .where(
        and(eq(schema.videoGenerationJobs.id, job.jobId), ne(schema.videoGenerationJobs.status, 'cancelled')),
      )
      .returning();
    if (!updated) throw new VideoGenerationCancelledError(job.jobId);
  };

  try {
    await setStage('brief');
    const firstFrame = await loadFirstFrame(ctx, job.jobId, request.productId);

    await setStage('generate');
    const generator = ctx.ai.videoGenerator();
    const { value: video, cost } = await withRetry(
      () =>
        withTimeout(
          generator.generate(
            {
              prompt: request.prompt,
              ...(firstFrame ? { firstFrame } : {}),
              width: request.width,
              height: request.height,
              durationSeconds: request.durationSeconds,
            },
            { referenceId: job.jobId, brandId: brand.id },
          ),
          VIDEO_TIMEOUT_MS,
          'video:generate',
        ),
      {
        onRetry: ({ attempt, delayMs, error }) =>
          console.warn(
            `[content:video] job ${job.jobId}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
          ),
      },
    );
    await recordCost(ctx, brand.id, job.jobId, cost);

    await setStage('qa');
    validateVideo(video.data, video.durationSeconds, request.durationSeconds);

    await setStage('storage');
    const key = `brands/${brand.id}/videos/${job.jobId}/video-1.mp4`;
    await ctx.storage.put(key, video.data, video.mediaType);

    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.videoAssets).values({
        jobId: job.jobId,
        storageKey: key,
        // Extracting a thumbnail frame needs a decoder this pipeline doesn't
        // have — see the schema comment on `videoAssets.thumbnailStorageKey`.
        thumbnailStorageKey: null,
        width: video.width,
        height: video.height,
        durationSeconds: video.durationSeconds,
        provider: generator.provider,
        model: video.model,
      });

      await tx
        .update(schema.videoGenerationJobs)
        .set({ status: 'succeeded', stage: null, error: null, finishedAt: new Date() })
        .where(eq(schema.videoGenerationJobs.id, job.jobId));
    });

    console.warn(`[content:video] job ${job.jobId}: succeeded — ${key}`);
  } catch (error) {
    if (error instanceof VideoGenerationCancelledError) {
      console.warn(`[content:video] job ${job.jobId}: cancelled by the user, stopping`);
      await ctx.db
        .update(schema.videoGenerationJobs)
        .set({ stage: null, finishedAt: new Date() })
        .where(eq(schema.videoGenerationJobs.id, job.jobId));
      return;
    }

    const permanent = isPermanentFailure(error);
    const isFinalAttempt = attemptInfo.attempt >= attemptInfo.maxAttempts;
    const terminal = permanent || isFinalAttempt;
    const message = describeError(error);

    console.error(
      `[content:video] job ${job.jobId}: attempt ${attemptInfo.attempt}/${attemptInfo.maxAttempts} failed${
        permanent ? ' — not retryable, giving up' : ''
      } — ${message}`,
      error,
    );

    await ctx.db
      .update(schema.videoGenerationJobs)
      .set(
        terminal
          ? { status: 'failed', error: message, finishedAt: new Date() }
          : { status: 'running', error: `${message} (retrying)` },
      )
      .where(eq(schema.videoGenerationJobs.id, job.jobId));

    if (permanent) {
      const stop = new UnrecoverableError(message);
      stop.cause = error;
      throw stop;
    }

    throw error;
  }
}
