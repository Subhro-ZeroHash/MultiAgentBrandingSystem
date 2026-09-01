import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI, type GenerateVideosOperation, type Video } from '@google/genai';
import { ProviderError, ProviderNotConfiguredError, describeError } from '../errors.js';
import { priceVideo } from '../pricing.js';
import { isQuotaExhausted, isRetryable } from '../resilience.js';
import type { ProviderContext, ProviderResult } from '../types.js';
import type {
  GeneratedVideo,
  VideoFrameImage,
  VideoGenerateRequest,
  VideoGenService,
} from '../video.js';

export interface GeminiVideoConfig {
  apiKey: string | undefined;
  model?: string;
  /** Overrides the API host — same reasoning as every other adapter's
   *  `baseUrl`. */
  baseUrl?: string;
}

/** Fast tier over the base/lite lines: this adapter's whole job is to be the
 *  thing that still works when LTX doesn't, not to be the best-quality
 *  option — Fast is roughly a third the cost of the base tier for that. */
const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';

/** Veo's supported resolutions, per the installed SDK's own config docs
 *  (`GenerateVideosConfig.resolution`) — 720p and 1080p only. No 4k here
 *  despite some marketing pages mentioning it elsewhere; this is what the
 *  actual client surface documents. */
const RESOLUTION_TIERS = [720, 1080] as const;

/** Veo's documented clip lengths — a fixed set, not an arbitrary range like
 *  LTX's 1-20s. A request outside this set is snapped to the nearest option
 *  at or above it, same "never render shorter than what was asked for"
 *  reasoning as `nearestVideoResolution` in ltx.video.ts. */
const DURATION_OPTIONS = [4, 6, 8] as const;

const POLL_INTERVAL_MS = 10_000;
/** Matches LTX's own polling ceiling — no documented reason for Veo to run
 *  meaningfully longer for an 8-second clip. */
const MAX_POLL_WAIT_MS = 10 * 60_000;

/** Snaps to the nearest Veo resolution tier at or above what was asked, and
 *  derives the aspect ratio (Veo only accepts 16:9 or 9:16, not arbitrary
 *  width/height) from whether the request is portrait or landscape. Mirrors
 *  `nearestVideoResolution` in ltx.video.ts so the two providers bill and
 *  report dimensions the same way for the same request. */
export function nearestVeoResolution(
  width: number,
  height: number,
): {
  width: number;
  height: number;
  tier: number;
  resolution: '720p' | '1080p';
  aspectRatio: '16:9' | '9:16';
} {
  const longEdge = Math.max(width, height);
  const portrait = height > width;

  const tier =
    RESOLUTION_TIERS.find((candidate) => (candidate * 16) / 9 >= longEdge) ??
    RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1]!;
  const otherEdge = Math.round((tier * 16) / 9);

  return {
    width: portrait ? tier : otherEdge,
    height: portrait ? otherEdge : tier,
    tier,
    resolution: tier === 1080 ? '1080p' : '720p',
    aspectRatio: portrait ? '9:16' : '16:9',
  };
}

/** Snaps to the nearest of Veo's fixed clip lengths, at or above the
 *  request. */
export function nearestVeoDuration(seconds: number): 4 | 6 | 8 {
  return (
    DURATION_OPTIONS.find((candidate) => candidate >= seconds) ??
    DURATION_OPTIONS[DURATION_OPTIONS.length - 1]!
  );
}

function toImagePart(frame: VideoFrameImage): { imageBytes: string; mimeType: string } {
  return { imageBytes: frame.data.toString('base64'), mimeType: frame.mediaType };
}

/**
 * Video generation via the Gemini API's Veo models, through the same
 * `@google/genai` SDK the image adapter already uses (never raw fetch — see
 * CLAUDE.md's SDK-boundary rule).
 *
 * Verified directly against the installed `@google/genai@2.12.0` package's
 * own type definitions and doc-comment usage example (`generateVideos` /
 * `operations.getVideosOperation`, `GenerateVideosConfig`'s field list,
 * `Video`'s `videoBytes`/`uri` shape) on 2026-08-31 — not recalled from
 * training data, per CLAUDE.md's "confirm before guessing" rule. Model ids
 * (`veo-3.1-*-generate-preview`) and per-second pricing cross-checked against
 * ai.google.dev's current Veo and pricing pages the same day.
 *
 * This is the fallback provider, not the primary — see
 * `generate-video.ts`'s `generateVideoWithFallback` for why LTX is tried
 * first and this only runs when it fails.
 */
export class GeminiVideoAdapter implements VideoGenService {
  readonly provider = 'google';
  private readonly client: GoogleGenAI | null;

  constructor(private readonly config: GeminiVideoConfig) {
    this.client = config.apiKey
      ? new GoogleGenAI({
          apiKey: config.apiKey,
          ...(config.baseUrl ? { httpOptions: { baseUrl: config.baseUrl } } : {}),
        })
      : null;
  }

  private require(): GoogleGenAI {
    if (!this.client) throw new ProviderNotConfiguredError('google', 'GOOGLE_API_KEY');
    return this.client;
  }

  private get model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  private static wrap(error: unknown, operation: string): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = describeError(error);

    if (isQuotaExhausted(error)) {
      return new ProviderError(
        `google.${operation}: quota exhausted — retrying will not help. ${message}`,
        'google',
        { retryable: false, cause: error },
      );
    }

    return new ProviderError(`google.${operation}: ${message}`, 'google', {
      retryable: isRetryable(error),
      cause: error,
    });
  }

  /**
   * Reads the finished operation's video into memory. The SDK's response
   * shape isn't guaranteed to populate the same field every time — inline
   * `videoBytes` avoids a network round trip entirely when present, but a
   * `uri`-only result needs the Files API's own download method, which
   * writes to a path rather than returning bytes. Both are handled instead
   * of assuming one, since nothing here observed which one a real account
   * gets before this was written.
   */
  private async materialize(video: Video): Promise<Buffer> {
    if (video.videoBytes) return Buffer.from(video.videoBytes, 'base64');

    if (!video.uri) {
      throw new ProviderError(
        'google.video: operation finished with neither videoBytes nor a uri',
        'google',
        {
          retryable: false,
        },
      );
    }

    const client = this.require();
    const tmpPath = join(tmpdir(), `veo-${randomUUID()}.mp4`);
    try {
      await client.files.download({ file: video, downloadPath: tmpPath });
      return await readFile(tmpPath);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  async generate(
    req: VideoGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedVideo>> {
    const startedAt = Date.now();
    const client = this.require();
    const resolved = nearestVeoResolution(req.width, req.height);
    const duration = nearestVeoDuration(req.durationSeconds);

    let operation: GenerateVideosOperation;
    try {
      operation = await client.models.generateVideos({
        model: this.model,
        prompt: req.prompt,
        ...(req.firstFrame ? { image: toImagePart(req.firstFrame) } : {}),
        config: {
          aspectRatio: resolved.aspectRatio,
          resolution: resolved.resolution,
          durationSeconds: duration,
          numberOfVideos: 1,
          ...(req.lastFrame ? { lastFrame: toImagePart(req.lastFrame) } : {}),
          ...(ctx?.signal ? { abortSignal: ctx.signal } : {}),
        },
      });
    } catch (error) {
      throw GeminiVideoAdapter.wrap(error, 'submit');
    }

    const deadline = Date.now() + MAX_POLL_WAIT_MS;
    while (!operation.done) {
      if (Date.now() >= deadline) {
        // ponytail: same tradeoff LTX's poll timeout documents — giving up
        // here discards an operation that may still complete server-side,
        // and a caller's retry pays for a second render. Upgrade path:
        // persist operation.name across the retry boundary so a retry
        // resumes this poll instead.
        throw new ProviderError(
          `google.video: operation still running after ${MAX_POLL_WAIT_MS / 1000}s, giving up`,
          'google',
          { retryable: true },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        operation = await client.operations.getVideosOperation({ operation });
      } catch (error) {
        throw GeminiVideoAdapter.wrap(error, 'poll');
      }
    }

    if (operation.error) {
      throw new ProviderError(`google.video: ${describeError(operation.error)}`, 'google', {
        // A provider-reported generation failure (content policy, bad
        // prompt) isn't fixed by an identical retry.
        retryable: false,
      });
    }

    const video = operation.response?.generatedVideos?.[0]?.video;
    if (!video) {
      throw new ProviderError('google.video: operation completed with no video', 'google', {
        retryable: false,
      });
    }

    const data = await this.materialize(video);

    return {
      value: {
        data,
        mediaType: 'video/mp4',
        width: resolved.width,
        height: resolved.height,
        durationSeconds: duration,
        model: this.model,
      },
      cost: {
        provider: this.provider,
        model: this.model,
        operation: 'video:generate',
        videoSeconds: duration,
        costMicroUsd: priceVideo(this.model, resolved.tier, duration),
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}
