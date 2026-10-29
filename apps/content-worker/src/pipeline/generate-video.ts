import {
  describeError,
  isPermanentFailure,
  withRetry,
  withTimeout,
  type GeneratedVideo,
  type LlmVisionRequest,
  type ProviderResult,
  type VideoGenerateRequest,
  type VideoProviderName,
} from '@bmas/ai';
import { and, asc, desc, eq, ne, schema, sql, type Brand } from '@bmas/db';
import type {
  CameraMove,
  CopyPack,
  CostEvent,
  CreativeRequest,
  ReferenceRole,
  StoryboardShot,
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoJobRequest,
  VideoMode,
} from '@bmas/shared';
import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import {
  CAMPAIGN_INTENT,
  STYLE_DIRECTION,
  generateCopy,
  mediaTypeFor,
  toneDirection,
} from './stages.js';
import { joinClips, lastFrame, shrinkVideo } from './video-edit.js';

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
 * `cinematic_broll` needs LTX's image-to-video conditioning; `advertisement`
 * needs Veo's stronger prompt adherence for on-brief energy. Both ship
 * exactly what the provider returned — no pixel touched, no text burned in.
 * See `videoModeSchema`'s doc comment in packages/shared for the full
 * reasoning.
 */
export const PROVIDER_FOR_MODE: Record<VideoMode, VideoProviderName> = {
  cinematic_broll: 'ltx',
  advertisement: 'google',
  higgsfield_story: 'higgsfield',
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
 * The product's primary photo, as the video's first frame. Only one: with a
 * second photo as the last frame the model has to morph between two
 * unrelated pictures, which is what turned clips into collages and changed
 * the product mid-shot. A chosen end frame can come back as an explicit
 * option, never as "whatever the second photo is".
 *
 * Best-effort: a product with no photos yet generates text-to-video rather
 * than failing the job — the same "a missing reference is a degraded
 * creative, not a failed one" reasoning `loadBrandReferences` uses for images.
 */
async function loadFirstFrame(
  ctx: WorkerContext,
  jobId: string,
  productId: string,
): Promise<ConditioningFrame | undefined> {
  const [row] = await ctx.db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, productId))
    .orderBy(desc(schema.productImages.isPrimary), asc(schema.productImages.createdAt))
    .limit(1);
  return row ? loadFrame(ctx, jobId, 'first', row) : undefined;
}

/** How far a first frame's shape may be from the video's: past this Veo pads
 *  it with grey bars and LTX crops into it. */
const FRAME_RATIO_TOLERANCE = 0.03;

const FRAME_CHECK_PROMPT =
  'Is this a plain photograph? Reply with exactly one word: CLEAN if it shows no text, ' +
  'letters, numbers, logos with lettering, price tags, stickers, graphic shapes, borders or ' +
  'collage panels; otherwise EDIT.';

const CLEAN_FRAME_PROMPT = [
  'Recreate the reference photo as a clean, realistic vertical photograph to be the first frame of a short video.',
  'Keep the product exactly as it is: the same shape, colours, materials, details and proportions. Do not redesign it.',
  'If people wear or hold it, keep them natural and in the same pose.',
  "Remove every piece of text, lettering, numbers, logos, price tags, stickers, graphic shapes, borders and collage panels. Add no signs or other brands' logos.",
  'Fill the whole frame with an uncluttered, natural setting that suits the product, with realistic light. No text anywhere.',
].join(' ');

/**
 * Makes the product photo a good first frame. Two things in it ruin a clip:
 * text or graphics (posters, price stickers, collages), which the model
 * animates into garbled letters, and a shape other than the video's. A photo
 * of the wrong shape is redrawn straight away; one of the right shape gets a
 * cheap vision check first, and is redrawn only if it isn't a plain photo.
 * The image model redraws from the photo itself, keeping the product.
 * Best-effort: any failure here keeps the photo as it was.
 */
// ponytail: a redraw per video (~$0.04 against a ~$2 clip); cache it on the
// product image if the same product is rendered often.
/** Leads every drawn opening frame. The style's graphic language (colour
 *  blocks, shapes) otherwise comes back as borders around the photo, which the
 *  video then keeps. */
const STILL_PROMPT =
  'A single realistic still photograph of a real scene with one clear subject, not a graphic design: no borders, frames, panels, colour blocks or shapes, and no text, shop signs or brand logos anywhere — including on clothing. It is the opening frame of this video.';

/**
 * A first frame for a product with no photo yet: the image model draws one
 * clean still from the video brief, and the video animates it. Animating a
 * still gives far more control than text alone, which is where the garbled
 * ad-style clips came from. Best-effort: on failure the clip is made from
 * text, as before.
 */
export async function createFirstFrame(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  videoPrompt: string,
  width: number,
  height: number,
): Promise<ConditioningFrame | undefined> {
  try {
    const {
      value: [image],
      cost,
    } = await withTimeout(
      ctx.ai.imageGenerator().generate(
        {
          prompt: `${STILL_PROMPT}\n\n${videoPrompt}`,
          references: [],
          width,
          height,
          count: 1,
        },
        { referenceId: jobId, brandId },
      ),
      180_000,
      'video:frame-create',
    );
    await recordCost(ctx, brandId, jobId, cost);
    return image && { data: image.data, mediaType: image.mediaType };
  } catch (error) {
    console.warn(
      `[content:video] job ${jobId}: could not draw a first frame, making the clip from text — ${describeError(error)}`,
    );
    return undefined;
  }
}

export async function prepareFirstFrame(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  frame: ConditioningFrame,
  width: number,
  height: number,
): Promise<ConditioningFrame> {
  try {
    const meta = await sharp(frame.data).metadata();
    const target = width / height;
    const shapeOff =
      !meta.width ||
      !meta.height ||
      Math.abs(meta.width / meta.height - target) / target > FRAME_RATIO_TOLERANCE;

    if (!shapeOff) {
      const { value: verdict, cost } = await withTimeout(
        ctx.ai
          .llm()
          .analyzeImage(
            { role: 'qa', prompt: FRAME_CHECK_PROMPT, images: [frame] },
            { referenceId: jobId, brandId },
          ),
        60_000,
        'video:frame-check',
      );
      await recordCost(ctx, brandId, jobId, cost);
      if (/^\W*CLEAN\b/i.test(verdict)) return frame;
    }

    const {
      value: [image],
      cost,
    } = await withTimeout(
      ctx.ai.imageGenerator().generate(
        {
          prompt: CLEAN_FRAME_PROMPT,
          references: [{ ...frame, label: 'product photo' }],
          width,
          height,
          count: 1,
        },
        { referenceId: jobId, brandId },
      ),
      180_000,
      'video:frame-clean',
    );
    await recordCost(ctx, brandId, jobId, cost);
    if (!image) return frame;
    console.warn(
      `[content:video] job ${jobId}: first frame redrawn (${shapeOff ? 'wrong shape' : 'text or graphics'})`,
    );
    return { data: image.data, mediaType: image.mediaType };
  } catch (error) {
    console.warn(
      `[content:video] job ${jobId}: could not prepare the first frame, using the photo as is — ${describeError(error)}`,
    );
    return frame;
  }
}

const STUDIO_STILL_COUNT = 4;

const ROLE_TEXT: Record<ReferenceRole, string> = {
  look: 'a look reference: match its composition, framing, setting, lighting and colours, but none of its products, text or logos',
  person: 'a person to feature: keep their face, hair, skin tone and build',
  place: 'the place to set the scene in',
};

/** A Studio upload. The key came from a client, so it is re-checked against
 *  the job's own brand here as well as in the request schema. */
async function loadReference(ctx: WorkerContext, brandId: string, key: string): Promise<Buffer> {
  if (!key.startsWith(`brands/${brandId}/references/`)) {
    throw new Error(`Reference ${key} does not belong to brand ${brandId}`);
  }
  return ctx.storage.get(key);
}

/**
 * Studio step one: opening frames drawn with the product photo and every
 * reference the user gave — four candidates of one shot, or one per
 * storyboard shot. The video engines take no reference images, so a still is
 * how references reach the clip: the engine animates it. Returns the stored
 * keys, in prompt order.
 */
async function drawStills(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  request: VideoGenerationRequest,
  prompts: string[],
  countEach: number,
): Promise<string[]> {
  const references = request.references ?? [];
  const [photo, ...uploads] = await Promise.all([
    loadFirstFrame(ctx, jobId, request.productId),
    ...references.map((ref) => loadReference(ctx, brandId, ref.key)),
  ]);
  const images = [
    ...(photo
      ? [
          {
            ...photo,
            role: 'the product: keep it exactly as it is — the same shape, colours, materials, details and proportions. Take only the product from this photo, not its background, layout, props, text or stickers; the scene comes from the direction below',
          },
        ]
      : []),
    ...uploads.map((data, i) => ({
      data,
      mediaType: mediaTypeFor(references[i]!.key),
      role: ROLE_TEXT[references[i]!.role],
    })),
  ];
  const guide = images.map((image, i) => `Image ${i + 1} is ${image.role}.`).join('\n');

  const drawn = await Promise.all(
    prompts.map(async (prompt) => {
      const { value, cost } = await withTimeout(
        ctx.ai.imageGenerator().generate(
          {
            prompt: [STILL_PROMPT, guide, prompt].filter(Boolean).join('\n\n'),
            references: images.map(({ data, mediaType }) => ({ data, mediaType })),
            width: request.width,
            height: request.height,
            count: countEach,
          },
          { referenceId: jobId, brandId },
        ),
        240_000,
        'video:stills',
      );
      await recordCost(ctx, brandId, jobId, cost);
      if (value.length === 0) throw new Error('The image model returned no stills');
      return value;
    }),
  );

  return Promise.all(
    drawn.flat().map(async (image, i) => {
      const key = `brands/${brandId}/videos/${jobId}/still-${i + 1}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`;
      await ctx.storage.put(key, image.data, image.mediaType);
      return key;
    }),
  );
}

async function loadStoredFrame(ctx: WorkerContext, key: string): Promise<ConditioningFrame> {
  return { data: await ctx.storage.get(key), mediaType: mediaTypeFor(key) };
}

/** A finished stills job (or any finished job, for Extend) of this brand. */
async function loadJobRow(ctx: WorkerContext, brandId: string, jobId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.id, jobId))
    .limit(1);
  if (!row || row.brandId !== brandId) throw new Error(`Video job ${jobId} not found`);
  return row;
}

const INLINE_VIDEO_BYTES = 14 * 1024 * 1024;

/** The sample reel for Gemini to watch: an upload's bytes, or a YouTube link. */
async function loadSampleVideo(
  ctx: WorkerContext,
  brandId: string,
  request: VideoGenerationRequest,
): Promise<LlmVisionRequest['video']> {
  if (request.sampleVideoUrl) return { url: request.sampleVideoUrl };
  const key = request.sampleVideoKey;
  if (!key) return undefined;
  const data = await loadReference(ctx, brandId, key);
  // A linked reel may be up to 50 MB; Gemini takes it inline only when small.
  if (data.length > INLINE_VIDEO_BYTES)
    return { data: await shrinkVideo(data), mediaType: 'video/mp4' };
  return { data, mediaType: key.endsWith('.mov') ? 'video/quicktime' : 'video/mp4' };
}

/** One storyboard shot's prompt: the shared brief, then what this shot shows. */
export function shotPrompt(brief: string, shot: StoryboardShot, i: number, total: number): string {
  return `${brief}\n\n**This shot (${i + 1} of ${total}, ${shot.seconds} seconds):** ${shot.direction}`;
}

/** The JSON object in a model reply, ignoring any code fence around it. */
function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

const storyboardSchema = z.object({
  shots: z
    .array(
      z.object({
        direction: z.string().trim().min(1).max(800),
        seconds: z.coerce.number(),
      }),
    )
    .min(2),
});

/**
 * Plans a storyboard: Gemini reads the brief (and watches the sample reel,
 * when there is one, mirroring its cuts) and returns the shots as JSON. Goes
 * through the vision call because that is the one that takes a video.
 */
export async function planShots(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  request: VideoGenerationRequest,
  brief: string,
  count: number,
): Promise<StoryboardShot[]> {
  const video = await loadSampleVideo(ctx, brandId, request);

  const { value, cost } = await withTimeout(
    ctx.ai.llm().analyzeImage(
      {
        role: 'qa',
        prompt: [
          `Plan a ${count}-shot marketing video from the brief below: exactly ${count} shots that together tell one short story about the product.`,
          video
            ? "Watch the sample video and mirror its cuts — its shot order, framing, camera moves and pacing — with our product as the subject. Never carry over the sample's own products, brands, text or people's names."
            : null,
          'Each shot is one continuous camera move with no cut inside it. The last shot shows the product clearly.',
          'Reply with JSON only, no other text: {"shots":[{"direction":"...","seconds":4}]}.',
          `"direction" is 1 to 3 sentences on what is in frame, what happens and how the camera moves. "seconds" is a whole number from 2 to 8${video ? ", matching the sample's pacing" : ', usually 3 to 5'}.`,
          `\nBRIEF:\n${brief}`,
        ]
          .filter(Boolean)
          .join(' '),
        images: [],
        ...(video ? { video } : {}),
        // Thinking tokens count against this cap; only used tokens are billed.
        maxTokens: 8_192,
      },
      { referenceId: jobId, brandId },
    ),
    180_000,
    'video:plan-shots',
  );
  await recordCost(ctx, brandId, jobId, cost);

  const parsed = storyboardSchema.safeParse(parseJsonObject(value));
  if (!parsed.success)
    throw new Error(`Gemini returned an unusable shot plan: ${value.slice(0, 200)}`);
  return parsed.data.shots.slice(0, count).map((shot) => ({
    direction: shot.direction,
    seconds: Math.min(8, Math.max(2, Math.round(shot.seconds) || 4)),
  }));
}

/** The Studio's camera presets, as the one line of direction each becomes. */
const CAMERA_DIRECTION: Record<CameraMove, string> = {
  static: 'a locked-off camera on a tripod; only the subject and the light move.',
  push_in: 'a slow, steady dolly push-in towards the subject.',
  pull_out: 'a slow pull-back that reveals the setting around the subject.',
  orbit: 'a smooth half-orbit around the subject at a constant distance.',
  pan: 'a slow sideways tracking move past the subject.',
  crane_up: 'a crane move rising up and over the subject.',
  handheld: 'a gentle handheld camera with natural sway, like a phone video.',
  top_down: 'an overhead top-down view, slowly rotating.',
};

/**
 * Studio "recreate this reel": Gemini watches the sample and writes the
 * direction for one continuous shot of our product with the same feel. Not
 * best-effort: a user who asked to recreate a reel and got an unrelated clip
 * has been charged for the wrong thing, so a failure fails the job.
 */
async function watchSampleVideo(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  request: VideoGenerationRequest,
): Promise<string> {
  const [video, [product]] = await Promise.all([
    loadSampleVideo(ctx, brandId, request),
    ctx.db
      .select({ name: schema.products.name, description: schema.products.description })
      .from(schema.products)
      .where(eq(schema.products.id, request.productId))
      .limit(1),
  ]);
  const subject = product
    ? `${product.name}${product.description ? ` (${product.description.trim()})` : ''}`
    : 'the product';

  const { value, cost } = await withTimeout(
    ctx.ai.llm().analyzeImage(
      {
        role: 'qa',
        prompt: [
          `Watch this sample video. Write the direction for recreating its look and feel as one continuous ${request.durationSeconds}-second shot whose subject is instead: ${subject}.`,
          'Cover the setting, how the subject is shown or used, camera movement and framing, lighting, colour palette, pace and mood.',
          'If the sample has several cuts, base it on its most striking shot and keep its overall energy.',
          // The user's own choices win; the sample fills in everything else.
          request.prompt
            ? `The user's own scene comes first — keep it and adapt the sample around it: ${request.prompt.replace(/@product\b/gi, 'the product')}.`
            : null,
          request.camera
            ? `Use this camera move instead of the sample's: ${CAMERA_DIRECTION[request.camera]}`
            : null,
          "Never mention the sample's own products, brands, logos, on-screen text, captions or people's names.",
          'Reply with 4 to 6 plain sentences and nothing else.',
        ]
          .filter(Boolean)
          .join(' '),
        images: [],
        ...(video ? { video } : {}),
        // Thinking tokens count against this cap; only used tokens are billed.
        maxTokens: 8_192,
      },
      { referenceId: jobId, brandId },
    ),
    180_000,
    'video:watch-sample',
  );
  await recordCost(ctx, brandId, jobId, cost);
  if (!value.trim()) throw new Error('Gemini returned no direction for the sample video');
  return value.trim();
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
 * `offerText`/`ctaText` are left out altogether — the caption carries them —
 * because any quoted phrase in a video prompt tends to be rendered, badly.
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
  /** What `watchSampleVideo` wrote, when the Studio was given a reel. */
  sampleDirection?: string,
): Promise<string> {
  const [product] = await ctx.db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, request.productId))
    .limit(1);
  if (!product) throw new Error(`Product ${request.productId} not found`);

  const description = product.description?.trim().replace(/[.\s]+$/, '');

  const lines: Array<string | null> = [
    `A short ${request.height > request.width ? 'vertical' : 'horizontal'} marketing video for ${CAMPAIGN_INTENT[request.campaignType]}.`,
    '',
    // The name is for understanding only: quoted titles are exactly what both
    // models wrote on screen, garbled ("The Bold Winter Edit").
    `**Subject** (never write this name in the video): ${product.name}${description ? ` — ${description}` : ''}.`,
    product.sellingPoints.length
      ? `Key selling points: ${product.sellingPoints.join(', ')}. Let the motion and framing bring these out (e.g. a close pass over a material or craft detail) rather than showing them as on-screen text.`
      : null,
    `${product.name} is the single subject of the clip. If it is a service, trip, or experience rather ` +
      'than a physical object, depict the experience itself — do not invent a physical object to stand in for it.',
    request.prompt ? `**Scene:** ${request.prompt.replace(/@product\b/gi, 'the product')}` : null,
    sampleDirection
      ? `**Recreate the sample video's look and feel** (this leads over the look below): ${sampleDirection}`
      : null,
    '',
    `**Brand:** ${brand.name}, tone ${toneDirection(brand.tone)}.`,
    brand.category
      ? `The brand's usual trade is "${brand.category}" — use this only to judge tone, not to introduce unrelated merchandise into frame.`
      : null,
    '',
    `**Look and motion:** ${STYLE_DIRECTION[request.styleTemplate]}`,
    // Headline and offer words stay out entirely — they go in the caption.
    // Quoted here they came back as garbled on-screen text, Veo's negative
    // prompt notwithstanding.
    request.extraInstructions?.trim()
      ? `Additional direction: ${request.extraInstructions.trim()}`
      : null,
    '',
    // Both models render text badly and break into collages when asked for a
    // sequence; LTX has no negative prompt, so the rule has to live here.
    request.camera ? `**Camera:** ${CAMERA_DIRECTION[request.camera]}` : null,
    `**Shot:** one continuous shot${request.camera ? '' : ' with smooth, unhurried camera movement'} — no cuts, no split screens, no collage, no transitions. Keep the product looking exactly the same throughout.`,
    'Never show text, letters, numbers, logos, captions or signs anywhere in frame.',
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

interface RenderedVideo {
  data: Buffer;
  width: number;
  height: number;
  durationSeconds: number;
  provider: string;
  model: string;
}

type SetStage = (stage: string) => Promise<void>;

/** One render on the job's engine, its cost recorded and its file checked. */
async function renderOne(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  request: VideoGenerationRequest,
  prompt: string,
  firstFrame: ConditioningFrame | undefined,
  durationSeconds: number,
): Promise<RenderedVideo> {
  const { value: video, cost } = await generateVideoForMode(
    ctx,
    request.videoMode,
    {
      prompt,
      ...(firstFrame ? { firstFrame } : {}),
      width: request.width,
      height: request.height,
      durationSeconds,
    },
    jobId,
    brandId,
  );
  await recordCost(ctx, brandId, jobId, cost);
  // Veo snaps to its own lengths, up to 8s, whatever was asked.
  validateVideo(video.data, video.durationSeconds, Math.max(durationSeconds, 8));
  return {
    data: video.data,
    width: video.width,
    height: video.height,
    durationSeconds: video.durationSeconds,
    // From the result, not the configured primary.
    provider: cost.provider,
    model: video.model,
  };
}

/**
 * A storyboard's Animate: every shot rendered from its own still, in
 * parallel, then joined in order. Each finished shot is stored first, so a
 * retry after one shot fails reuses the others instead of paying for them
 * again.
 */
async function renderStoryboard(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  request: VideoGenerationRequest,
  stills: { brief: string; frames: string[]; shots: StoryboardShot[] },
  setStage: SetStage,
): Promise<RenderedVideo> {
  const { brief, frames, shots } = stills;
  await setStage('generate');
  const clips = await Promise.all(
    shots.map(async (shot, i): Promise<Partial<RenderedVideo> & { data: Buffer }> => {
      const key = `brands/${brandId}/videos/${jobId}/shot-${i + 1}.mp4`;
      const stored = await ctx.storage.get(key).catch(() => null);
      if (stored) return { data: stored };
      const frame = await loadStoredFrame(ctx, frames[i]!);
      const prompt = shotPrompt(brief, shot, i, shots.length);
      const clip = await renderOne(ctx, brandId, jobId, request, prompt, frame, shot.seconds);
      await ctx.storage.put(key, clip.data, 'video/mp4');
      return clip;
    }),
  );

  await setStage('stitch');
  const joined = await joinClips(
    clips.map((clip) => clip.data),
    shots.map((shot) => shot.seconds),
    request.width,
    request.height,
  );
  const fresh = clips.find((clip) => clip.model);
  return {
    ...joined,
    width: request.width,
    height: request.height,
    provider: fresh?.provider ?? PROVIDER_FOR_MODE[request.videoMode],
    model: fresh?.model ?? 'reused shots',
  };
}

const EXTEND_SECONDS = 6;

/**
 * A video's Extend: its last frame opens a new clip that carries on the same
 * shot, and the two are joined. Works on either engine with no extend API —
 * Veo's only extends clips Veo made, and only for two days. The extension
 * keeps the source's caption.
 */
async function renderExtension(
  ctx: WorkerContext,
  brand: Brand,
  jobId: string,
  request: VideoJobRequest,
  setStage: SetStage,
): Promise<{ video: RenderedVideo; brief: string; copy: CopyPack | null | undefined }> {
  const source = await loadJobRow(ctx, brand.id, request.extend!.jobId);
  const [asset] = await ctx.db
    .select()
    .from(schema.videoAssets)
    .where(eq(schema.videoAssets.jobId, source.id))
    .orderBy(asc(schema.videoAssets.createdAt))
    .limit(1);
  if (!asset) throw new Error(`Video job ${source.id} has no video to extend`);

  const original = await ctx.storage.get(asset.storageKey);
  // Videos made before briefs were stored get theirs recomposed.
  const brief =
    source.brief ??
    (await composeVideoBrief(ctx, brand, source.request as unknown as VideoGenerationRequest));
  const next = request.extend!.prompt;
  const prompt = `${brief}\n\n**Continue the shot:** this clip starts exactly where the previous one ended, from this frame — the same subject, setting, light and camera direction, with no cut.${next ? ` Then: ${next}` : ''}`;

  await setStage('generate');
  const frame = { data: await lastFrame(original), mediaType: 'image/jpeg' as const };
  const clip = await renderOne(ctx, brand.id, jobId, request, prompt, frame, EXTEND_SECONDS);

  await setStage('stitch');
  const joined = await joinClips(
    [original, clip.data],
    [asset.durationSeconds, EXTEND_SECONDS],
    asset.width,
    asset.height,
  );
  return {
    video: { ...clip, ...joined, width: asset.width, height: asset.height },
    brief,
    copy: source.copy ?? undefined,
  };
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

  const request = row.request as unknown as VideoJobRequest;

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
    let video: RenderedVideo;
    let brief: string;
    /** Left undefined to have a caption written; an extension keeps its source's. */
    let copy: CopyPack | null | undefined;

    if (request.extend) {
      ({ video, brief, copy } = await renderExtension(ctx, brand, job.jobId, request, setStage));
    } else if (request.fromStills) {
      const stills = await loadJobRow(ctx, brand.id, request.fromStills.jobId);
      if (!stills.brief || !stills.frames) throw new Error(`Job ${stills.id} has no stills`);
      brief = stills.brief;
      if (stills.shots) {
        video = await renderStoryboard(
          ctx,
          brand.id,
          job.jobId,
          request,
          {
            brief,
            frames: stills.frames,
            shots: stills.shots,
          },
          setStage,
        );
      } else {
        const key = stills.frames[request.fromStills.index ?? -1];
        if (!key) throw new Error(`Job ${stills.id} has no still ${request.fromStills.index}`);
        // Studio Animate: the picked still is already clean and the right shape.
        await setStage('generate');
        const frame = await loadStoredFrame(ctx, key);
        video = await renderOne(
          ctx,
          brand.id,
          job.jobId,
          request,
          brief,
          frame,
          request.durationSeconds,
        );
      }
    } else {
      // A storyboard watches the sample itself, to follow its cuts.
      const sampleDirection =
        (request.sampleVideoKey || request.sampleVideoUrl) && !request.shots
          ? await watchSampleVideo(ctx, brand.id, job.jobId, request)
          : undefined;
      brief = await composeVideoBrief(ctx, brand, request, sampleDirection);

      if (request.stillsOnly) {
        let shots: StoryboardShot[] | null = null;
        if (request.shots) {
          await setStage('plan');
          shots = await planShots(ctx, brand.id, job.jobId, request, brief, request.shots);
        }
        await setStage('stills');
        const frames = shots
          ? await drawStills(
              ctx,
              brand.id,
              job.jobId,
              request,
              shots.map((shot, i) => shotPrompt(brief, shot, i, shots.length)),
              1,
            )
          : await drawStills(ctx, brand.id, job.jobId, request, [brief], STUDIO_STILL_COUNT);
        await ctx.db
          .update(schema.videoGenerationJobs)
          .set({
            status: 'succeeded',
            stage: null,
            error: null,
            frames,
            brief,
            shots,
            finishedAt: new Date(),
          })
          .where(eq(schema.videoGenerationJobs.id, job.jobId));
        console.warn(`[content:video] job ${job.jobId}: ${frames.length} stills ready`);
        return;
      }

      const photo = await loadFirstFrame(ctx, job.jobId, request.productId);
      const firstFrame = photo
        ? await prepareFirstFrame(ctx, brand.id, job.jobId, photo, request.width, request.height)
        : await createFirstFrame(ctx, brand.id, job.jobId, brief, request.width, request.height);
      await setStage('generate');
      video = await renderOne(
        ctx,
        brand.id,
        job.jobId,
        request,
        brief,
        firstFrame,
        request.durationSeconds,
      );
    }

    // After the render, not alongside it: copy is cheap but not free, and a
    // job that fails to produce a video has no use for a caption.
    if (copy === undefined) {
      await setStage('copy');
      copy = await generateVideoCopy(ctx, brand, request, job.jobId);
    }

    await setStage('storage');
    const key = `brands/${brand.id}/videos/${job.jobId}/video-1.mp4`;
    await ctx.storage.put(key, video.data, 'video/mp4');

    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.videoAssets).values({
        jobId: job.jobId,
        storageKey: key,
        // ponytail: no thumbnail yet; video-edit.ts's lastFrame shows how
        // ffmpeg could take one if a list ever needs it.
        thumbnailStorageKey: null,
        width: video.width,
        height: video.height,
        durationSeconds: video.durationSeconds,
        provider: video.provider,
        model: video.model,
      });

      await tx
        .update(schema.videoGenerationJobs)
        .set({
          status: 'succeeded',
          stage: null,
          error: null,
          copy,
          // Kept so the video can be extended with the same direction.
          brief,
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
