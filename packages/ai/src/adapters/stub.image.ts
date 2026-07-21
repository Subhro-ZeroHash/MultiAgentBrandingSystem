import sharp from 'sharp';
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenService,
} from '../image.js';
import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface StubImageConfig {
  /** Artificial latency per image, ms. Lets the UI's per-stage progress be
   *  exercised without a real provider's response time. */
  latencyMs?: number;
}

const MODEL = 'stub-placeholder';

/** SVG is XML: unescaped user text (an offer like "50% off & free delivery")
 *  would produce an invalid document and sharp would throw. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deterministic placeholder generator — draws an image instead of calling a
 * provider. Not a mock in the testing sense: it satisfies `ImageGenService`
 * fully and returns real PNG bytes, so storage, persistence, and the API
 * response are all exercised for real.
 *
 * Exists so the pipeline can be built and demonstrated while provider access is
 * pending, and so local development and CI don't spend money on every run.
 * Selected only when `IMAGE_PROVIDER_PRIMARY=stub`; the default stays `gemini`.
 *
 * Every output is watermarked and reports `provider: 'stub'` with zero cost, so
 * a placeholder can never be mistaken for a real creative in the asset table or
 * the cost ledger.
 */
export class StubImageAdapter implements ImageGenService {
  readonly provider = 'stub';

  constructor(private readonly config: StubImageConfig = {}) {}

  private async render(
    width: number,
    height: number,
    lines: string[],
    colors: string[] | undefined,
    badge: string,
  ): Promise<GeneratedImage> {
    const [bg = '#1F2937', accent = '#F59E0B'] = colors ?? [];
    // Scale type to the canvas so a 1080x1080 post and a 2480x3508 A4 poster
    // both come out legible.
    const unit = Math.min(width, height);
    const titleSize = Math.round(unit * 0.075);
    const bodySize = Math.round(unit * 0.042);
    const badgeSize = Math.round(unit * 0.03);

    const body = lines
      .filter(Boolean)
      .slice(0, 6)
      .map(
        (line, i) =>
          `<text x="50%" y="${height / 2 + titleSize + i * bodySize * 1.4}" ` +
          `text-anchor="middle" font-family="Helvetica, Arial, sans-serif" ` +
          `font-size="${bodySize}" fill="#FFFFFF" opacity="0.92">${escapeXml(line)}</text>`,
      )
      .join('');

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${escapeXml(bg)}"/>
      <rect x="${unit * 0.03}" y="${unit * 0.03}"
            width="${width - unit * 0.06}" height="${height - unit * 0.06}"
            fill="none" stroke="${escapeXml(accent)}" stroke-width="${Math.max(2, unit * 0.008)}"/>
      <text x="50%" y="${height / 2}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${titleSize}"
            font-weight="bold" fill="${escapeXml(accent)}">PLACEHOLDER</text>
      ${body}
      <text x="50%" y="${height - unit * 0.06}" text-anchor="middle"
            font-family="Helvetica, Arial, sans-serif" font-size="${badgeSize}"
            fill="#FFFFFF" opacity="0.6">${escapeXml(badge)} — NOT AI GENERATED</text>
    </svg>`;

    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    return { data, mediaType: 'image/png', width, height, model: MODEL };
  }

  private async delay(): Promise<void> {
    const ms = this.config.latencyMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async generate(
    req: ImageGenerateRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage[]>> {
    const startedAt = Date.now();
    await this.delay();

    const images = await Promise.all(
      Array.from({ length: req.count }, (_unused, i) =>
        this.render(
          req.width,
          req.height,
          [...(req.requiredText ?? []), `variant ${i + 1} of ${req.count}`],
          req.brandColors,
          `stub ${req.width}x${req.height}`,
        ),
      ),
    );

    return {
      value: images,
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'image:generate',
        imageCount: images.length,
        // Explicit rather than inherited from the rate table: a stub must never
        // contribute spend, even if someone later adds a rate for this model id.
        costMicroUsd: 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  async edit(
    req: ImageEditRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedImage>> {
    const startedAt = Date.now();
    await this.delay();

    // Read the real dimensions off the incoming asset so an edit round-trips at
    // the same size the caller already stored.
    const meta = await sharp(req.image).metadata();
    const image = await this.render(
      meta.width ?? 1024,
      meta.height ?? 1024,
      ['edit applied:', req.instruction],
      undefined,
      'stub edit',
    );

    return {
      value: image,
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'image:edit',
        imageCount: 1,
        costMicroUsd: 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
