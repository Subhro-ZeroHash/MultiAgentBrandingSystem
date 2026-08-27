import type { ProviderContext, ProviderResult } from './types.js';

/**
 * A single conditioning frame — not a reference bundle. Unlike image
 * generation's `references: ReferenceImage[]` (many product/logo/style photos
 * conditioning one call), video providers take at most one image per frame
 * position: this is a starting or ending frame the video is generated around,
 * not visual context for a model to draw on.
 */
export interface VideoFrameImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface GeneratedVideo {
  data: Buffer;
  mediaType: 'video/mp4';
  width: number;
  height: number;
  durationSeconds: number;
  model: string;
}

export interface VideoGenerateRequest {
  /** Composed by the brief stage — never user-authored. */
  prompt: string;
  /** The video's first frame. Undefined means text-to-video with no visual
   *  anchor; set it to animate a specific product shot or creative instead of
   *  letting the model invent the opening frame. */
  firstFrame?: VideoFrameImage;
  /** The video's last frame. Rarely set — most briefs care about a strong
   *  opening, not a specific close — but some providers support it and a
   *  brief occasionally wants to land on a specific end card. */
  lastFrame?: VideoFrameImage;
  width: number;
  height: number;
  durationSeconds: number;
}

/**
 * The abstraction that lets us ride the model-release treadmill, same
 * reasoning as `ImageGenService`. One method: video generation has no
 * equivalent to `edit` yet (nothing today re-touches a rendered clip), so
 * there is nothing to mirror there until a real use case asks for it.
 *
 * Deliberately synchronous-looking despite most real providers running
 * generation as an async job underneath (submit, poll, fetch). That polling
 * is the adapter's own problem to hide, the same way `withRetry` hides
 * request-level retries from callers — a pipeline stage that awaits
 * `generate()` should not need to know or care whether the provider answered
 * in one HTTP round trip or forty.
 */
export interface VideoGenService {
  readonly provider: string;

  generate(
    req: VideoGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedVideo>>;
}
