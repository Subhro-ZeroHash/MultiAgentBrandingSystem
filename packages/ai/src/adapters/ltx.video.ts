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

export interface LtxVideoConfig {
  apiKey: string | undefined;
  model?: string;
  /** Overrides the API host — same reasoning as every other adapter's
   *  `baseUrl`: local dev/CI can point this at a mock and exercise real
   *  request/response handling with no credentials or spend. */
  baseUrl?: string;
}

/**
 * `ltx-2-5-fast` over the pro tier or the 2.3 line: cheapest model that still
 * supports audio-to-video and up to 4K, and marketing clips have no reason to
 * default to the slower/pricier `-pro` variant. Overridable per call site once
 * one actually needs the quality difference.
 */
const DEFAULT_MODEL = 'ltx-2-5-fast';

/** LTX's documented ceiling; requests never ask for more than this regardless
 *  of what a caller passes. */
const MAX_DURATION_SECONDS = 20;

/** LTX rejects shorter clips with a 400 rather than silently rounding up —
 *  confirmed live against `ltx-2-5-fast` at 720p/24fps on 2026-09-02: a
 *  1-second request was refused, 2 seconds was accepted. Not documented on
 *  LTX's reference pages, so this floor is only verified at that resolution;
 *  raise it further if a higher tier turns out to need more. */
const MIN_DURATION_SECONDS = 2;

/** The exact tiers LTX prices (see VIDEO_RATES in pricing.ts) — a request for
 *  anything else is snapped to the nearest one at or above it, same "ask for
 *  at least what's needed so the fit downsamples" reasoning as
 *  `imageSizeFor` for images. */
const RESOLUTION_TIERS = [720, 1080, 1440, 2160] as const;

const UPLOAD_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** How long a request is allowed to sit in the queue before this adapter
 *  reports it as failed rather than hanging forever. LTX's own docs put
 *  text-to-video at up to 20s of output at up to 4K; ten minutes is
 *  comfortably above any observed render time with room for queue depth. */
const MAX_POLL_WAIT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;

interface UploadResponse {
  upload_url: string;
  storage_uri: string;
  required_headers?: Record<string, string>;
}

interface JobResponse {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: { video_url: string };
  error?: { type?: string; message?: string };
}

/** Snaps to the nearest LTX resolution tier whose long edge is at or above
 *  what was asked — never down, so a request never renders smaller than what
 *  it asked for. Same tier lookup `priceVideo` bills against. */
export function nearestVideoResolution(
  width: number,
  height: number,
): { width: number; height: number; tier: number } {
  const longEdge = Math.max(width, height);
  const portrait = height > width;

  // `tier` names the standard resolution ("1080" for 1080p) — the SHORT edge
  // of its 16:9 landscape pair (1920x1080), not the long one. A tier's actual
  // long edge is `tier * 16/9` (1080 -> 1920), which is what the request's own
  // long edge has to be compared against.
  const tier =
    RESOLUTION_TIERS.find((candidate) => (candidate * 16) / 9 >= longEdge) ??
    RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1]!;
  const otherEdge = Math.round((tier * 16) / 9);

  return portrait
    ? { width: tier, height: otherEdge, tier }
    : { width: otherEdge, height: tier, tier };
}

export function clampDuration(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), MIN_DURATION_SECONDS), MAX_DURATION_SECONDS);
}

/**
 * Video generation via LTX's async job API — LTX's own documented
 * recommendation for production over the sync endpoints, and the only
 * sensible choice here regardless: a render can plausibly run well past a
 * single HTTP request's comfortable lifetime, and the sync endpoints return
 * the exact same failure mode (a dropped connection) with none of the async
 * path's ability to keep polling through it.
 *
 * Contract verified directly against docs.ltx.io's actual API reference pages
 * (not the marketing overview) on 2026-08-27 — auth header, endpoint paths,
 * upload flow, and job response shape are all taken from real reference/code
 * samples, not recalled from training data. LTX is a brand-new integration
 * with no prior spend or traffic to sanity-check a wrong guess against, which
 * is exactly the situation CLAUDE.md's "confirm before guessing" rule exists
 * for.
 *
 * One documented gap: the upload endpoint's exact POST body isn't shown in
 * LTX's reference pages, only its response shape and the PUT step that
 * follows. `{ content_type }` is what fits every presigned-upload API of this
 * shape; if LTX's real behaviour differs, the first live call against a real
 * key will surface a 4xx here, not a silent wrong upload.
 */
export class LtxVideoAdapter implements VideoGenService {
  readonly provider = 'ltx';
  private readonly baseUrl: string;

  constructor(private readonly config: LtxVideoConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.ltx.io';
  }

  private get model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  private requireKey(): string {
    if (!this.config.apiKey) throw new ProviderNotConfiguredError('ltx', 'LTX_API_KEY');
    return this.config.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.requireKey()}`,
      'Content-Type': 'application/json',
    };
  }

  private static wrap(error: unknown, operation: string): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = describeError(error);

    if (isQuotaExhausted(error)) {
      return new ProviderError(
        `ltx.${operation}: quota exhausted — retrying will not help. ${message}`,
        'ltx',
        { retryable: false, cause: error },
      );
    }

    return new ProviderError(`ltx.${operation}: ${message}`, 'ltx', {
      retryable: isRetryable(error),
      cause: error,
    });
  }

  /** Raw HTTP failures (a non-2xx or a network error) into the same
   *  `ProviderError` shape every adapter throws, so the caller's
   *  retry/permanent-failure classification works identically regardless of
   *  which provider it's looking at. */
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
      throw LtxVideoAdapter.wrap(error, operation);
    } finally {
      clearTimeout(timer);
      ctx?.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `ltx.${operation}: HTTP ${response.status} — ${body.slice(0, 300)}`,
        'ltx',
        {
          // 4xx other than 408/429 is a bad request/key and will never succeed
          // on retry; LTX's own error.type on a failed job is checked
          // separately once a job is actually parsed, not here.
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Puts one conditioning frame through LTX's presigned-upload flow and
   * returns the `storage_uri` a generation request references it by. Files
   * live for 24h on LTX's side — irrelevant here since the resulting
   * `storage_uri` is consumed by the very next call this adapter makes.
   */
  private async uploadFrame(frame: VideoFrameImage, ctx?: ProviderContext): Promise<string> {
    const uploaded = await LtxVideoAdapter.fetchJson<UploadResponse>(
      `${this.baseUrl}/v1/upload`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content_type: frame.mediaType }),
      },
      UPLOAD_TIMEOUT_MS,
      'upload',
      ctx,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const put = await fetch(uploaded.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': frame.mediaType, ...(uploaded.required_headers ?? {}) },
        body: new Uint8Array(frame.data),
        signal: controller.signal,
      });
      if (!put.ok) {
        throw new ProviderError(
          `ltx.upload: PUT to signed URL failed with HTTP ${put.status}`,
          'ltx',
          {
            retryable: put.status >= 500,
          },
        );
      }
    } catch (error) {
      throw LtxVideoAdapter.wrap(error, 'upload');
    } finally {
      clearTimeout(timer);
    }

    return uploaded.storage_uri;
  }

  /** Submits the async job and returns its id. Branches on whether a first
   *  frame was given — LTX exposes text-to-video and image-to-video as
   *  distinct endpoints, not one endpoint with an optional image field. */
  private async submit(
    req: VideoGenerateRequest,
    resolution: { width: number; height: number },
    duration: number,
    ctx?: ProviderContext,
  ): Promise<string> {
    const endpoint = req.firstFrame ? 'image-to-video' : 'text-to-video';

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: this.model,
      duration,
      resolution: `${resolution.width}x${resolution.height}`,
    };

    if (req.firstFrame) {
      body.image_uri = await this.uploadFrame(req.firstFrame, ctx);
    }
    if (req.lastFrame) {
      body.last_frame_uri = await this.uploadFrame(req.lastFrame, ctx);
    }

    const submitted = await LtxVideoAdapter.fetchJson<JobResponse>(
      `${this.baseUrl}/v2/${endpoint}`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      SUBMIT_TIMEOUT_MS,
      'submit',
      ctx,
    );

    return submitted.id;
  }

  /** Polls until the job leaves `pending`/`processing`, bounded by
   *  `MAX_POLL_WAIT_MS` so a stuck job fails loudly instead of hanging the
   *  worker slot it's running in forever. */
  private async awaitCompletion(
    endpoint: 'text-to-video' | 'image-to-video',
    jobId: string,
    ctx?: ProviderContext,
  ): Promise<{ video_url: string }> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;

    for (;;) {
      const job = await LtxVideoAdapter.fetchJson<JobResponse>(
        `${this.baseUrl}/v2/${endpoint}/${jobId}`,
        { method: 'GET', headers: this.headers() },
        POLL_TIMEOUT_MS,
        'poll',
        ctx,
      );

      if (job.status === 'completed') {
        if (!job.result?.video_url) {
          throw new ProviderError(`ltx.poll: job ${jobId} completed with no video_url`, 'ltx', {
            retryable: false,
          });
        }
        return job.result;
      }

      if (job.status === 'failed') {
        throw new ProviderError(
          `ltx.poll: job ${jobId} failed — ${job.error?.type ?? 'unknown'}: ${job.error?.message ?? 'no detail'}`,
          'ltx',
          // A provider-reported generation failure (bad prompt, content
          // policy) is not fixed by asking again with the identical request.
          { retryable: false },
        );
      }

      if (Date.now() >= deadline) {
        // ponytail: marking this retryable means a caller's retry
        // re-submits a brand-new job rather than resuming this poll — this
        // job id is discarded, and if it later completes LTX-side, that
        // render is paid for and unused. Resuming would need the job id
        // persisted across the caller's retry boundary, which no caller
        // does today. Upgrade path: thread jobId through ProviderContext (or
        // have the pipeline persist it) so a retry polls the same job
        // instead of paying for a second render of an identical request.
        throw new ProviderError(
          `ltx.poll: job ${jobId} still '${job.status}' after ${MAX_POLL_WAIT_MS / 1000}s, giving up`,
          'ltx',
          { retryable: true },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async download(url: string, ctx?: ProviderContext): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    ctx?.signal?.addEventListener('abort', onAbort);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new ProviderError(
          `ltx.download: HTTP ${response.status} fetching result video`,
          'ltx',
          {
            retryable: response.status >= 500,
          },
        );
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw LtxVideoAdapter.wrap(error, 'download');
    } finally {
      clearTimeout(timer);
      ctx?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async generate(
    req: VideoGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedVideo>> {
    const startedAt = Date.now();
    const resolution = nearestVideoResolution(req.width, req.height);
    const duration = clampDuration(req.durationSeconds);
    const endpoint = req.firstFrame ? 'image-to-video' : 'text-to-video';

    const jobId = await this.submit(req, resolution, duration, ctx);
    const result = await this.awaitCompletion(endpoint, jobId, ctx);
    const data = await this.download(result.video_url, ctx);

    return {
      value: {
        data,
        mediaType: 'video/mp4',
        width: resolution.width,
        height: resolution.height,
        durationSeconds: duration,
        model: this.model,
      },
      cost: {
        provider: this.provider,
        model: this.model,
        operation: 'video:generate',
        videoSeconds: duration,
        costMicroUsd: priceVideo(this.model, resolution.tier, duration),
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}
