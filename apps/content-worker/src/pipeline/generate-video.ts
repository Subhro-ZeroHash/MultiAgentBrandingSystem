import {
  describeError,
  isPermanentFailure,
  withRetry,
  withTimeout,
  type GeneratedVideo,
  type ProviderResult,
  type VideoGenerateRequest,
  type VideoProviderName,
} from '@bmas/ai';
import { and, asc, desc, eq, ne, schema, sql, type Brand } from '@bmas/db';
import type {
  CopyPack,
  CostEvent,
  CreativeRequest,
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoMode,
} from '@bmas/shared';
import { UnrecoverableError } from 'bullmq';
import type { WorkerContext } from '../context.js';
import {
  CAMPAIGN_INTENT,
  STYLE_DIRECTION,
  generateCopy,
  mediaTypeFor,
  toneDirection,
} from './stages.js';
import { addEndCard } from './video-endcard.js';

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

async function recordCost(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  cost: CostEvent,
): Promise<void> {
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
 * `videoMode` is the one thing that decides which provider renders a job —
 * two different products, not a quality tier with a fallback between them.
 * `cinematic_broll` needs LTX's image-to-video conditioning and ships its
 * output untouched; `advertisement` needs Veo's stronger prompt adherence
 * for on-brief energy and gets the closing message burned in afterward. See
 * `videoModeSchema`'s doc comment in packages/shared for the full reasoning.
 */
const PROVIDER_FOR_MODE: Record<VideoMode, VideoProviderName> = {
  cinematic_broll: 'ltx',
  advertisement: 'google',
};

/**
 * Renders on the one provider `videoMode` maps to, retrying transient
 * failures on that provider only. Deliberately no fallback to the other
 * provider on exhaustion: unlike the old single-primary pipeline, a mode is
 * a caller's explicit choice of *product* (raw footage vs. a finished ad),
 * and silently handing back the other one under the chosen label would be
 * wrong regardless of which one still worked.
 */
async function generateVideoForMode(
  ctx: WorkerContext,
  mode: VideoMode,
  request: VideoGenerateRequest,
  jobId: string,
  brandId: string,
): Promise<ProviderResult<GeneratedVideo>> {
  const generator = ctx.ai.videoGenerator(PROVIDER_FOR_MODE[mode]);
  return withRetry(
    () =>
      withTimeout(
        generator.generate(request, { referenceId: jobId, brandId }),
        VIDEO_TIMEOUT_MS,
        `video:generate (${generator.provider})`,
      ),
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[content:video] job ${jobId}: ${generator.provider} attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
        ),
    },
  );
}

type ConditioningFrame = { data: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' };

async function loadFrame(
  ctx: WorkerContext,
  jobId: string,
  label: 'first' | 'last',
  row: { storageKey: string; cleanedStorageKey: string | null },
): Promise<ConditioningFrame | undefined> {
  try {
    const key = row.cleanedStorageKey ?? row.storageKey;
    return { data: await ctx.storage.get(key), mediaType: mediaTypeFor(key) };
  } catch (error) {
    console.warn(
      `[content:video] job ${jobId}: could not load the ${label} conditioning frame — ${describeError(error)}`,
    );
    return undefined;
  }
}

/**
 * The product's photos, as video conditioning frames: the primary photo as
 * `firstFrame`, and — when a product has more than one — a second, distinct
 * photo as `lastFrame`, so both providers' image-to-video path has an actual
 * start and end to interpolate between instead of just one static reference.
 * Never every photo the way image generation conditions on all of them: both
 * LTX and Veo's APIs take exactly two image slots, not an arbitrary list.
 *
 * Best-effort: a product with no photos yet generates text-to-video rather
 * than failing the job — the same "a missing reference is a degraded
 * creative, not a failed one" reasoning `loadBrandReferences` uses for images.
 */
async function loadConditioningFrames(
  ctx: WorkerContext,
  jobId: string,
  productId: string,
): Promise<{ firstFrame?: ConditioningFrame; lastFrame?: ConditioningFrame }> {
  const rows = await ctx.db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, productId))
    .orderBy(desc(schema.productImages.isPrimary), asc(schema.productImages.createdAt))
    .limit(2);
  if (rows.length === 0) return {};

  const [firstFrame, lastRow] = await Promise.all([
    loadFrame(ctx, jobId, 'first', rows[0]!),
    rows[1] ? loadFrame(ctx, jobId, 'last', rows[1]) : Promise.resolve(undefined),
  ]);

  return { firstFrame, lastFrame: lastRow };
}

/**
 * Video's counterpart to `composeBrief` — turns the same structured intake
 * (product, style, campaign type, offer/headline/extra instructions) plus
 * the Brand Kit into one prompt, the way `composeBrief` does for images.
 * Reuses `STYLE_DIRECTION`/`CAMPAIGN_INTENT`/`toneDirection` verbatim: the
 * same style choice should read as the same style whichever medium a
 * Reel/Story selection happens to produce.
 *
 * Deliberately not asked to render legible on-screen text the way a poster
 * brief does. Video-diffusion models are far less reliable at accurate text
 * rendering than an image model, and this pipeline has no vision-QA pass to
 * catch it getting the text wrong (see `validateVideo` below) — asking for
 * something nobody checks is worse than not asking. `headlineText`/
 * `offerText`/`ctaText` instead inform the mood and message the clip is
 * building toward, the same "let this inform styling, not the subject"
 * treatment `composeBrief` already gives `brand.category`.
 *
 * Deterministic templating, not an LLM call — same reasoning `composeBrief`
 * gives for itself, and it means this owes nothing to Gemini: a brand-new
 * video pipeline built specifically to get content generation off Gemini
 * would be an odd place to introduce a fresh dependency on it.
 */
export async function composeVideoBrief(
  ctx: WorkerContext,
  brand: Brand,
  request: VideoGenerationRequest,
): Promise<string> {
  const [product] = await ctx.db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, request.productId))
    .limit(1);
  if (!product) throw new Error(`Product ${request.productId} not found`);

  const description = product.description?.trim().replace(/[.\s]+$/, '');

  const lines: Array<string | null> = [
    `A short vertical marketing video for ${CAMPAIGN_INTENT[request.campaignType]}.`,
    '',
    `**Subject:** ${product.name}${description ? ` — ${description}` : ''}.`,
    product.sellingPoints.length
      ? `Key selling points: ${product.sellingPoints.join(', ')}. Let the motion and framing bring these out (e.g. a close pass over a material or craft detail) rather than showing them as on-screen text.`
      : null,
    `${product.name} is the single subject of the clip. If it is a service, trip, or experience rather ` +
      'than a physical object, depict the experience itself — do not invent a physical object to stand in for it.',
    '',
    `**Brand:** ${brand.name}, tone ${toneDirection(brand.tone)}.`,
    brand.category
      ? `The brand's usual trade is "${brand.category}" — use this only to judge tone, not to introduce unrelated merchandise into frame.`
      : null,
    '',
    `**Look and motion:** ${STYLE_DIRECTION[request.styleTemplate]}`,
    request.headlineText?.trim()
      ? `The headline for this campaign is "${request.headlineText.trim()}" — let it inform the mood and pacing, not on-screen text.`
      : null,
    request.offerText?.trim()
      ? `The offer being promoted is "${request.offerText.trim()}" — build energy toward it rather than displaying it as text.`
      : null,
    request.extraInstructions?.trim()
      ? `Additional direction: ${request.extraInstructions.trim()}`
      : null,
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

/**
 * The clip's copy pack, from the same `generateCopy` stage images already
 * use — a Reel caption is the same job as a post caption, and this way the
 * two mediums stay in one voice instead of drifting apart as that prompt is
 * tuned. `story_reel_cover` is the format video already declares itself
 * equivalent to (see `videoGenerationRequestSchema`'s width/height comment),
 * and it maps to the same 'instagram' platform a Reel posts to.
 *
 * Best-effort by design: a caption is worth a retry, but not worth throwing
 * away a video that already rendered and cost real money. A failure here
 * leaves `copy` null and the user writes their own caption, which is exactly
 * the behaviour that shipped before this stage existed.
 */
async function generateVideoCopy(
  ctx: WorkerContext,
  brand: Brand,
  request: VideoGenerationRequest,
  jobId: string,
): Promise<CopyPack | null> {
  const copyRequest: CreativeRequest = {
    ...request,
    outputFormat: 'story_reel_cover',
    variantCount: 1,
    variantMode: 'uniform',
    language: 'en',
  };

  try {
    const [pack] = await generateCopy({
      ai: ctx.ai,
      brand,
      request: copyRequest,
      db: ctx.db,
      storage: ctx.storage,
      jobId,
    });
    return pack ?? null;
  } catch (error) {
    console.warn(
      `[content:video] job ${jobId}: copy generation failed, posting screen will open with an empty caption — ${describeError(error)}`,
    );
    return null;
  }
}

/**
 * Burns the closing message on, or returns the clip untouched if it can't.
 *
 * Best-effort for the same reason the copy stage is: the video has already
 * rendered and already cost money by the time this runs, and a missing font
 * or an ffmpeg that isn't installed is an operational problem with the box,
 * not a reason to throw away the thing the user is waiting for. A silent
 * clip is a worse ad than one with a caption, but it is still an ad.
 */
async function burnEndCard(
  ctx: WorkerContext,
  video: Buffer,
  options: { headline: string; cta?: string | undefined; durationSeconds: number; jobId: string },
): Promise<Buffer> {
  try {
    return await addEndCard(
      video,
      { headline: options.headline, cta: options.cta },
      options.durationSeconds,
      ctx.videoEndCardFontBold,
      ctx.videoEndCardFont,
    );
  } catch (error) {
    console.warn(
      `[content:video] job ${options.jobId}: end card could not be drawn, posting the clip without it — ${describeError(error)}`,
    );
    return video;
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
    throw new Error(
      `video is suspiciously small (${data.length} bytes) — likely a truncated download`,
    );
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

  // brandId comes off the row, not the queue payload — see generate.ts's
  // identical comment for why.
  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, row.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${row.brandId} not found`);

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
        and(
          eq(schema.videoGenerationJobs.id, job.jobId),
          ne(schema.videoGenerationJobs.status, 'cancelled'),
        ),
      )
      .returning();
    if (!updated) throw new VideoGenerationCancelledError(job.jobId);
  };

  try {
    await setStage('brief');
    const [prompt, frames] = await Promise.all([
      composeVideoBrief(ctx, brand, request),
      loadConditioningFrames(ctx, job.jobId, request.productId),
    ]);

    await setStage('generate');
    const { value: video, cost } = await generateVideoForMode(
      ctx,
      request.videoMode,
      {
        prompt,
        ...(frames.firstFrame ? { firstFrame: frames.firstFrame } : {}),
        ...(frames.lastFrame ? { lastFrame: frames.lastFrame } : {}),
        width: request.width,
        height: request.height,
        durationSeconds: request.durationSeconds,
      },
      job.jobId,
      brand.id,
    );
    await recordCost(ctx, brand.id, job.jobId, cost);

    await setStage('qa');
    validateVideo(video.data, video.durationSeconds, request.durationSeconds);

    // After the render, not alongside it: copy is cheap but not free, and a
    // job that fails to produce a video has no use for a caption.
    await setStage('copy');
    const copy = await generateVideoCopy(ctx, brand, request, job.jobId);

    // `cinematic_broll` ships exactly what LTX returned — no end card, no
    // pixel touched. Only `advertisement` gets the closing message burned in,
    // preferring what the user typed over what the model wrote:
    // `headlineText` is the one line they chose themselves, and silently
    // replacing it with a generated alternative would be the app overruling
    // them.
    const endCardHeadline = request.headlineText?.trim() || copy?.headline;
    const finalVideo =
      request.videoMode === 'advertisement' && endCardHeadline
        ? await burnEndCard(ctx, video.data, {
            headline: endCardHeadline,
            cta: request.ctaText?.trim() || copy?.cta,
            durationSeconds: video.durationSeconds,
            jobId: job.jobId,
          })
        : video.data;

    await setStage('storage');
    const key = `brands/${brand.id}/videos/${job.jobId}/video-1.mp4`;
    await ctx.storage.put(key, finalVideo, video.mediaType);

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
        // From the result, not the configured primary — a fallback run
        // means this is whichever provider in the chain actually succeeded.
        provider: cost.provider,
        model: video.model,
      });

      await tx
        .update(schema.videoGenerationJobs)
        .set({
          status: 'succeeded',
          stage: null,
          error: null,
          copy,
          finishedAt: new Date(),
        })
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
