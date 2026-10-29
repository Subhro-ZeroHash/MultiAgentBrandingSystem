import { ProviderError, ProviderNotConfiguredError, describeError } from '../errors.js';
import { isQuotaExhausted, isRetryable } from '../resilience.js';
import type { ProviderContext, ProviderResult } from '../types.js';
import type {
  GeneratedVideo,
  VideoGenerateRequest,
  VideoGenService,
} from '../video.js';

export interface HiggsfieldVideoConfig {
  /** Combined key in the form `keyId:keySecret` as printed in the cloud dashboard. */
  apiKey: string | undefined;
  /** Default model / model path fragment. Defaults to `bytedance/seedance-2.5`. */
  model?: string;
  /** Overrides the API host — same reasoning as every other adapter's baseUrl:
   *  local dev/CI can point this at a mock. */
  baseUrl?: string;
}

/**
 * Seedance 2.5 is Higgsfield's flagship text-to-video model: fast, supports
 * 720p/1080p, aspect ratios 16:9 and 9:16, up to 10s. Matches the duration
 * range the rest of this pipeline uses (10s minimum).
 */
const DEFAULT_MODEL = 'bytedance/seedance-2.5';

/** Higgsfield's polling interval and total wait ceiling — observed median
 *  generation time is ~30-90s. Ten minutes gives generous room. */
const MAX_POLL_WAIT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface SubmitResponse {
  request_id: string;
}

interface StatusResponse {
  status: 'queued' | 'in_progress' | 'processing' | 'completed' | 'failed' | 'nsfw';
  request_id: string;
  video?: { url?: string };
  output?: { video_url?: string; url?: string };
  video_url?: string;
  error?: string;
  detail?: string;
}

/** Map the internal width/height pair to Higgsfield's aspect_ratio string. */
export function aspectRatioFor(width: number, height: number): '16:9' | '9:16' | '1:1' {
  if (width > height) return '16:9';
  if (height > width) return '9:16';
  return '1:1';
}

/** Snap requested duration to the nearest Higgsfield-supported duration in
 *  seconds. Higgsfield Seedance 2.5 accepts 5 or 10 s; we always ask for 10
 *  since the pipeline minimum is already 10s. */
export function clampDuration(seconds: number): number {
  // Clamp to the supported ceiling of 10 s; floor to 5.
  return seconds >= 10 ? 10 : 5;
}

/**
 * Video generation via Higgsfield AI's async REST API.
 *
 * Flow:
 *  1. POST /{model}/text-to-video  →  { request_id }
 *  2. Poll GET /requests/{request_id}/status  until status === 'completed'
 *  3. Download the mp4 from video.url
 *
 * Auth: `Authorization: Key {keyId}:{keySecret}`
 * Base URL: https://api.higgsfield.ai
 *
 * API shape confirmed against Higgsfield's published reference and the
 * open-source SDK on 2026-10-28.
 */
export class HiggsfieldVideoAdapter implements VideoGenService {
  readonly provider = 'higgsfield';
  private readonly baseUrl: string;

  constructor(private readonly config: HiggsfieldVideoConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.higgsfield.ai';
  }

  private get model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  private requireKey(): string {
    if (!this.config.apiKey) {
      throw new ProviderNotConfiguredError('higgsfield', 'HIGGSFIELD_API_KEY');
    }
    return this.config.apiKey;
  }

  private headers(): Record<string, string> {
    const rawKey = this.requireKey().trim();
    const authHeader = rawKey.startsWith('Key ') ? rawKey : `Key ${rawKey}`;
    return {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    };
  }

  private static wrap(error: unknown, operation: string): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = describeError(error);

    if (isQuotaExhausted(error)) {
      return new ProviderError(
        `higgsfield.${operation}: quota exhausted — retrying will not help. ${message}`,
        'higgsfield',
        { retryable: false, cause: error },
      );
    }

    return new ProviderError(`higgsfield.${operation}: ${message}`, 'higgsfield', {
      retryable: isRetryable(error),
      cause: error,
    });
  }

  private static async fetchJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    operation: string,
    ctx?: ProviderContext,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    ctx?.signal?.addEventListener('abort', onAbort);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw HiggsfieldVideoAdapter.wrap(error, operation);
    } finally {
      clearTimeout(timer);
      ctx?.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `higgsfield.${operation}: HTTP ${response.status} — ${body.slice(0, 300)}`,
        'higgsfield',
        {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }

    return (await response.json()) as T;
  }

  /** Submit a text-to-video generation job and return the request_id. */
  private async submit(
    req: VideoGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<string> {
    const aspectRatio = aspectRatioFor(req.width, req.height);
    const duration = clampDuration(req.durationSeconds);
    // Resolution: use 1080p for landscape (1920×1080), 720p for portrait (1080×1920)
    // to keep costs reasonable while still being HD.
    const resolution = req.width >= 1920 || req.height >= 1920 ? '1080p' : '720p';

    const result = await HiggsfieldVideoAdapter.fetchJson<SubmitResponse>(
      `${this.baseUrl}/${this.model}/text-to-video`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          prompt: req.prompt,
          duration,
          resolution,
          aspect_ratio: aspectRatio,
          output_format: 'mp4',
        }),
      },
      SUBMIT_TIMEOUT_MS,
      'submit',
      ctx,
    );

    return result.request_id;
  }

  /** Poll until the job completes (or fails / times out). */
  private async poll(
    requestId: string,
    ctx?: ProviderContext,
  ): Promise<StatusResponse> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;

    while (Date.now() < deadline) {
      if (ctx?.signal?.aborted) {
        throw new ProviderError('higgsfield.poll: cancelled by caller', 'higgsfield', {
          retryable: false,
        });
      }

      const status = await HiggsfieldVideoAdapter.fetchJson<StatusResponse>(
        `${this.baseUrl}/requests/${requestId}/status`,
        { method: 'GET', headers: this.headers() },
        POLL_TIMEOUT_MS,
        'poll',
        ctx,
      );

      if (status.status === 'completed') return status;

      if (status.status === 'failed') {
        throw new ProviderError(
          `higgsfield.poll: generation failed — ${status.error ?? 'no details'}`,
          'higgsfield',
          { retryable: false },
        );
      }

      // Still queued / processing — wait and retry.
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new ProviderError(
      `higgsfield.poll: timed out after ${MAX_POLL_WAIT_MS / 60_000} min`,
      'higgsfield',
      { retryable: true },
    );
  }

  /** Download the mp4 bytes from Higgsfield's CDN URL. */
  private static async download(
    videoUrl: string,
    ctx?: ProviderContext,
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    ctx?.signal?.addEventListener('abort', onAbort);

    let response: Response;
    try {
      response = await fetch(videoUrl, { signal: controller.signal });
    } catch (error) {
      throw HiggsfieldVideoAdapter.wrap(error, 'download');
    } finally {
      clearTimeout(timer);
      ctx?.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new ProviderError(
        `higgsfield.download: HTTP ${response.status} from CDN`,
        'higgsfield',
        { retryable: response.status >= 500 },
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async generate(
    req: VideoGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedVideo>> {
    const startMs = Date.now();

    let requestId: string;
    try {
      requestId = await this.submit(req, ctx);
    } catch (error) {
      throw HiggsfieldVideoAdapter.wrap(error, 'submit');
    }

    let completed: StatusResponse;
    try {
      completed = await this.poll(requestId, ctx);
    } catch (error) {
      throw HiggsfieldVideoAdapter.wrap(error, 'poll');
    }

    const videoUrl =
      completed.output?.video_url ??
      completed.output?.url ??
      completed.video?.url ??
      completed.video_url;

    if (!videoUrl) {
      throw new ProviderError(
        'higgsfield.generate: completed but no video URL in response',
        'higgsfield',
        { retryable: false },
      );
    }

    const data = await HiggsfieldVideoAdapter.download(videoUrl, ctx);
    const latencyMs = Date.now() - startMs;

    const video: GeneratedVideo = {
      data,
      mediaType: 'video/mp4',
      width: req.width,
      height: req.height,
      durationSeconds: clampDuration(req.durationSeconds),
      model: this.model,
    };

    return {
      value: video,
      cost: {
        provider: 'higgsfield',
        model: this.model,
        operation: 'video:generate',
        videoSeconds: video.durationSeconds,
        // Higgsfield doesn't publish a per-second price in their API response;
        // set costMicroUsd to 0 and track via dashboard until they expose it.
        costMicroUsd: 0,
        latencyMs,
      },
    };
  }
}
