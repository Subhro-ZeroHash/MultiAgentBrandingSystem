import { z } from 'zod';
import { campaignTypeSchema, styleTemplateSchema } from './creative.js';
import { entityIdSchema } from '../common.js';

/**
 * What a caller submits to generate a video.
 *
 * Deliberately the same structured vocabulary `creativeRequestSchema` uses —
 * `campaignType`, `styleTemplate`, `headlineText`/`offerText`/`ctaText`,
 * `extraInstructions` — rather than a raw prompt the client writes itself.
 * The Create page has no "describe your video" box: a video is what a Story/
 * Reel selection on the same product-and-style form the image path already
 * uses produces, so the worker needs the same structured intake to compose a
 * real brief from (see `composeVideoBrief` in generate-video.ts, the video
 * counterpart of `composeBrief`). The website's Studio adds an optional
 * `prompt` and the other Studio fields below; the worker still composes the
 * brief around them. `outputFormat` isn't part of it — a video is a Reel
 * (or, from the Studio, a 16:9 wide clip).
 *
 * `productId` is required, unlike an early version of this schema: a video
 * always comes from the same "create a product, then generate" flow images
 * do now, so there is always one to condition on and to read
 * name/description/sellingPoints from.
 */
export const videoModeSchema = z.enum(['cinematic_broll', 'advertisement', 'higgsfield_story']);
export type VideoMode = z.infer<typeof videoModeSchema>;

/** Studio camera presets. Prompt-level for both engines: neither API takes a
 *  camera parameter. */
export const cameraMoveSchema = z.enum([
  'static',
  'push_in',
  'pull_out',
  'orbit',
  'pan',
  'crane_up',
  'handheld',
  'top_down',
]);
export type CameraMove = z.infer<typeof cameraMoveSchema>;

/** What a Studio reference image is for: a look to copy, a person to feature,
 *  or a place to set the scene in. */
export const referenceRoleSchema = z.enum(['look', 'person', 'place']);
export type ReferenceRole = z.infer<typeof referenceRoleSchema>;

/** A file uploaded through POST /brands/:id/references. The brand segment is
 *  checked against the request's brandId below, so a request can only point at
 *  its own brand's uploads. */
const REFERENCE_KEY =
  /^brands\/([A-Za-z0-9-]+)\/references\/[A-Za-z0-9-]+\.(png|jpg|webp|mp4|mov)$/;
const referenceImageKey = z
  .string()
  .regex(REFERENCE_KEY)
  .refine((key) => !/\.(mp4|mov)$/.test(key));
const referenceVideoKey = z
  .string()
  .regex(REFERENCE_KEY)
  .refine((key) => /\.(mp4|mov)$/.test(key));
const keyBrand = (key: string) => REFERENCE_KEY.exec(key)?.[1];

export const videoGenerationRequestSchema = z
  .object({
    brandId: entityIdSchema,
    productId: entityIdSchema,
    campaignType: campaignTypeSchema,
    styleTemplate: styleTemplateSchema,
    /** Picks the provider — not a quality tier, two different products.
     *  `cinematic_broll` renders on LTX (raw supplementary footage);
     *  `advertisement` renders on Gemini's Veo models;
     *  `higgsfield_story` renders on Higgsfield AI (social-first vertical clips).
     *  Each mode is pinned to its own provider — see
     *  `PROVIDER_FOR_MODE` in generate-video.ts — there is no fallback between
     *  them, so an outage doesn't silently hand back a different engine's footage. */
    videoMode: videoModeSchema.default('cinematic_broll'),
    headlineText: z.string().max(80).optional(),
    offerText: z.string().max(40).optional(),
    ctaText: z.string().max(40).optional(),
    /** FR-2.4-equivalent escape hatch, same role it plays for images. */
    extraInstructions: z.string().max(500).optional(),
    /** Every video this pipeline makes is at least 10s. LTX renders this exactly
     *  (its own ceiling is 20s). Veo has no 10s tier at all — the closest it has
     *  is 8s — so an `advertisement` request is accepted here and then snapped
     *  down to its nearest option (8s) by `nearestVeoDuration` in
     *  gemini.video.ts; that's an accepted provider ceiling, not a bug, and the
     *  one case where the finished video is shorter than requested. */
    durationSeconds: z.number().int().min(10).max(20).default(10),
    /** 1080×1920 (a Reel, the default) or 1920×1080 — the only two shapes
     *  both providers render; a square refine below rules out 1080×1080. */
    width: z.union([z.literal(1080), z.literal(1920)]).default(1080),
    height: z.union([z.literal(1920), z.literal(1080)]).default(1920),

    // Studio fields — all optional, so the Create page's requests are unchanged.
    /** The user's own scene direction. '@product' stands for the product. */
    prompt: z.string().trim().max(1000).optional(),
    camera: cameraMoveSchema.optional(),
    /** Feed the stills only: the video engines take no reference images, so
     *  they reach the clip through the still it animates. */
    references: z
      .array(z.object({ key: referenceImageKey, role: referenceRoleSchema }))
      .max(3)
      .optional(),
    /** A reel to recreate: Gemini watches it and writes the shot's direction. */
    sampleVideoKey: referenceVideoKey.optional(),
    /** Or a public YouTube video, which Gemini watches from the link itself. */
    sampleVideoUrl: z
      .string()
      .regex(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/)
      .optional(),
    /** Draw four candidate opening frames and stop; the user picks one and
     *  POST /video-generations/:id/animate renders it. */
    stillsOnly: z.boolean().optional(),
    /** With stillsOnly: plan a storyboard of this many shots (following a
     *  sample reel's cuts when there is one), one still each. Animate then
     *  renders every shot and joins them into one video. */
    shots: z.number().int().min(2).max(4).optional(),
  })
  .refine((r) => r.width !== r.height, { message: 'Video must be 1080×1920 or 1920×1080' })
  .refine((r) => !r.shots || r.stillsOnly, { message: 'shots needs stillsOnly' })
  .refine((r) => !(r.sampleVideoKey && r.sampleVideoUrl), { message: 'One sample reel at a time' })
  .refine(
    (r) =>
      [...(r.references ?? []).map((ref) => ref.key), r.sampleVideoKey]
        .filter((key): key is string => Boolean(key))
        .every((key) => keyBrand(key) === r.brandId),
    { message: 'References must be uploads of this brand' },
  );
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;

/** A video job row's stored request: what the client sent, plus what the
 *  Studio's Animate or a video's Extend set server-side — the public schema
 *  above strips both. `index` is unset when a storyboard renders every shot. */
export type VideoJobRequest = VideoGenerationRequest & {
  fromStills?: { jobId: string; index?: number };
  extend?: { jobId: string; prompt?: string };
};

/** One planned shot of a Studio storyboard. */
export interface StoryboardShot {
  direction: string;
  seconds: number;
}

export const animateStillSchema = z.object({
  /** Which still to animate; leave unset for a storyboard, which renders all. */
  index: z.number().int().min(0).max(3).optional(),
  videoMode: videoModeSchema.default('cinematic_broll'),
  durationSeconds: z.number().int().min(10).max(20).default(10),
});
export type AnimateStillInput = z.infer<typeof animateStillSchema>;

/** Continue a finished video from its last frame. */
export const extendVideoSchema = z.object({
  /** What happens next; empty continues the shot as it was. */
  prompt: z.string().trim().max(500).optional(),
});
export type ExtendVideoInput = z.infer<typeof extendVideoSchema>;

export const videoAssetSchema = z.object({
  id: entityIdSchema,
  url: z.string().url(),
  thumbnailUrl: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  provider: z.string(),
  model: z.string(),
});
export type VideoAsset = z.infer<typeof videoAssetSchema>;
