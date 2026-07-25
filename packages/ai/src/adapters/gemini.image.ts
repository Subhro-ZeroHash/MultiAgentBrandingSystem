import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { ProviderError, ProviderNotConfiguredError, describeError } from '../errors.js';
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenService,
  ReferenceImage,
} from '../image.js';
import { buildCostEvent } from '../pricing.js';
import { isQuotaExhausted, isRetryable } from '../resilience.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface GeminiImageConfig {
  apiKey: string | undefined;
  model?: string;
  /** Overrides the API host. Unset in every deployed environment; exists so
   *  local development and CI can point at a mock and exercise this adapter's
   *  real request/response handling without credentials or spend. */
  baseUrl?: string;
}

const DEFAULT_MODEL = 'gemini-3-pro-image-preview';

/**
 * Ceiling on a single provider request. A pro-tier image takes 40–60s, so this
 * is deliberately generous; its job is only to stop a half-open socket holding
 * a worker slot until the stage timeout fires. Without it the SDK waits on
 * Node's default, which outlives the caller's own timeout and makes a dropped
 * connection look like a hang rather than a retryable failure.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Gemini accepts an aspect ratio and a size tier, not arbitrary pixel
 * dimensions. Our output formats do not all land on one of these — poster_a4 is
 * 1:1.414 — so the closest ratio is requested and the result fitted afterwards.
 */
const SUPPORTED_ASPECTS: Array<[string, number]> = [
  ['1:1', 1],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
];

export function nearestAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_ASPECTS[0]!;
  for (const candidate of SUPPORTED_ASPECTS) {
    if (Math.abs(candidate[1] - target) < Math.abs(best[1] - target)) best = candidate;
  }
  return best[0];
}

/** Ask for at least the resolution needed so the fit down-samples rather than
 *  up-samples — a 1K render enlarged to A4 at 300dpi looks soft. */
export function imageSizeFor(width: number, height: number): '1K' | '2K' | '4K' {
  const longEdge = Math.max(width, height);
  if (longEdge <= 1280) return '1K';
  if (longEdge <= 2560) return '2K';
  return '4K';
}

/**
 * Primary image generator (PRD §7.2): multi-reference product fidelity plus
 * legible, multilingual on-image text.
 *
 * Uses `models.generateContent`, not `models.generateImages`. The latter drives
 * the Imagen family via `predict`; every Gemini image model exposes only
 * `generateContent`, and it needs `responseModalities` to include IMAGE or the
 * model replies with prose describing an image instead of an image.
 *
 * The model id is pinned in config (`IMAGE_MODEL_GEMINI`) precisely because it
 * changes often. `gemini-3-pro-image-preview` was confirmed live via ListModels;
 * a stable `gemini-3-pro-image` also exists and is the better long-term pin.
 *
 * Retries are deliberately not applied here — callers wrap this in `withRetry`,
 * and nesting the two multiplies the attempt count. What this adapter owes the
 * caller is accurate classification, which is why provider failures are mapped
 * to ProviderError with a correct `retryable` flag.
 */
export class GeminiImageAdapter implements ImageGenService {
  readonly provider = 'google';
  private readonly client: GoogleGenAI | null;

  constructor(private readonly config: GeminiImageConfig) {
    this.client = config.apiKey
      ? new GoogleGenAI({
          apiKey: config.apiKey,
          httpOptions: {
            timeout: REQUEST_TIMEOUT_MS,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          },
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

  /** Reference photos go in as inline image parts ahead of the instruction, so
   *  the model reads them as context for the prompt that follows. */
  private static referenceParts(references: ReferenceImage[]): Array<Record<string, unknown>> {
    return references.map((reference) => ({
      inlineData: {
        mimeType: reference.mediaType,
        data: reference.data.toString('base64'),
      },
    }));
  }

  /**
   * The distinction that matters is retryable vs not: a 429 from a burst clears
   * in seconds, a 429 carrying `limit: 0` never will.
   */
  private static wrap(error: unknown, operation: string): ProviderError {
    if (error instanceof ProviderError) return error;
    // The whole chain, not `.message`: a transport failure arrives as a bare
    // `TypeError: fetch failed` and says nothing without its cause.
    const message = describeError(error);

    if (isQuotaExhausted(error)) {
      return new ProviderError(
        `google.${operation}: quota exhausted (limit: 0) — the project has no allocation, ` +
          `so retrying will not help. ${message}`,
        'google',
        { retryable: false, cause: error },
      );
    }

    return new ProviderError(`google.${operation}: ${message}`, 'google', {
      retryable: isRetryable(error),
      cause: error,
    });
  }

  /** One call yields one image, so N variants is N calls. Shared by generate
   *  and edit so both get the same parsing and the same failure modes. */
  private async requestImage(
    parts: Array<Record<string, unknown>>,
    imageConfig: Record<string, string>,
    operation: string,
    ctx?: ProviderContext,
  ): Promise<{
    data: Buffer;
    mediaType: 'image/png' | 'image/jpeg';
    inputTokens: number;
    outputTokens: number;
  }> {
    let response;
    try {
      response = await this.require().models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          // Without IMAGE the model returns a description instead of a picture.
          // TEXT is kept so refusals and caveats come back readable.
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig,
          ...(ctx?.signal ? { abortSignal: ctx.signal } : {}),
        },
      });
    } catch (error) {
      throw GeminiImageAdapter.wrap(error, operation);
    }

    const responseParts = response.candidates?.[0]?.content?.parts ?? [];
    const image = responseParts.find((part) => part.inlineData?.data);

    if (!image?.inlineData?.data) {
      // A refusal, a safety block, or an answer in prose. Retryable: image
      // models are non-deterministic and a second attempt often complies.
      const said = responseParts
        .map((part) => part.text)
        .filter(Boolean)
        .join(' ')
        .slice(0, 200);
      throw new ProviderError(
        `google.${operation}: no image in response${said ? ` — model said: ${said}` : ''}`,
        'google',
        { retryable: true },
      );
    }

    const usage = response.usageMetadata;
    return {
      data: Buffer.from(image.inlineData.data, 'base64'),
      mediaType: image.inlineData.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  /** Gemini renders at its own supported sizes, so results are fitted to the
   *  exact output format. `cover` preserves composition and crops the overflow
   *  rather than distorting the product. */
  private static async fit(
    data: Buffer,
    mediaType: 'image/png' | 'image/jpeg',
    width: number,
    height: number,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const resized = sharp(data).resize(width, height, { fit: 'cover', position: 'centre' });
    const out = await (mediaType === 'image/jpeg'
      ? resized.jpeg({ quality: 92 })
      : resized.png()
    ).toBuffer({ resolveWithObject: true });

    return { data: out.data, width: out.info.width, height: out.info.height };
  }

  async generate(
    req: ImageGenerateRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage[]>> {
    const startedAt = Date.now();
    const imageConfig = {
      aspectRatio: nearestAspectRatio(req.width, req.height),
      imageSize: imageSizeFor(req.width, req.height),
    };

    const parts = [...GeminiImageAdapter.referenceParts(req.references), { text: req.prompt }];

    // Variants are independent calls, fanned out concurrently because the stage
    // is latency-bound. The caller's retry policy uses jittered backoff, so a
    // rate limit does not send all N into lockstep retries.
    const results = await Promise.all(
      Array.from({ length: req.count }, () =>
        this.requestImage(parts, imageConfig, 'generate', ctx),
      ),
    );

    const images: GeneratedImage[] = await Promise.all(
      results.map(async (result) => {
        const fitted = await GeminiImageAdapter.fit(
          result.data,
          result.mediaType,
          req.width,
          req.height,
        );
        return {
          data: fitted.data,
          mediaType: result.mediaType,
          width: fitted.width,
          height: fitted.height,
          model: this.model,
        };
      }),
    );

    return {
      value: images,
      cost: buildCostEvent({
        provider: this.provider,
        model: this.model,
        operation: 'image:generate',
        imageCount: images.length,
        inputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
        outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async edit(req: ImageEditRequest, ctx?: ProviderContext): Promise<ProviderResult<GeneratedImage>> {
    const startedAt = Date.now();

    // Preserve the asset's dimensions: an edit is a targeted change to a
    // creative the customer already accepted, not a reformat (FR-3.3).
    const meta = await sharp(req.image).metadata();
    const width = meta.width ?? 1024;
    const height = meta.height ?? 1024;

    const parts = [
      // The image being edited leads, then any extra references, then the
      // instruction — the model treats the first image as the subject.
      { inlineData: { mimeType: req.mediaType, data: req.image.toString('base64') } },
      ...GeminiImageAdapter.referenceParts(req.references ?? []),
      {
        text:
          'Apply this edit to the image, changing only what is asked and leaving everything ' +
          `else identical: ${req.instruction}`,
      },
    ];

    const result = await this.requestImage(
      parts,
      { aspectRatio: nearestAspectRatio(width, height), imageSize: imageSizeFor(width, height) },
      'edit',
      ctx,
    );

    const fitted = await GeminiImageAdapter.fit(result.data, result.mediaType, width, height);

    return {
      value: {
        data: fitted.data,
        mediaType: result.mediaType,
        width: fitted.width,
        height: fitted.height,
        model: this.model,
      },
      cost: buildCostEvent({
        provider: this.provider,
        model: this.model,
        operation: 'image:edit',
        imageCount: 1,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
