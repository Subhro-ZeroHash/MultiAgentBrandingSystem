import { withRetry, withTimeout, type AiRegistry } from '@bmas/ai';
import { eq, schema, type Brand, type Database } from '@bmas/db';
import {
  OUTPUT_FORMAT_DIMENSIONS,
  copyPackSchema,
  type CampaignType,
  type CopyPack,
  type CostEvent,
  type CreativeRequest,
  type OutputFormat,
  type Platform,
  type StyleTemplate,
  type ToneOfVoice,
} from '@bmas/shared';
import { z } from 'zod';
import { creativeKey, type Storage } from '../storage.js';

/**
 * The four pipeline stages. Each is a pure-ish function of (registry, input) so
 * a stage can be tested, reordered, or retried independently — this is the
 * pattern the later agents (video, publishing, monitoring) will follow.
 */

export interface StageContext {
  ai: AiRegistry;
  brand: Brand;
  request: CreativeRequest;
  /** Stages resolve their own reads: the request carries a `productId`, not the
   *  product or its photos, and the image stage needs both. */
  db: Database;
  storage: Storage;
  /** Correlates provider spend and storage keys back to this job. */
  jobId: string;
}

/** What stage 1 hands to stage 2. Carries the resolved pixel dimensions and the
 *  text that must survive onto the image, so the image stage never re-derives
 *  them from the request and risk drifting from what the prompt asked for. */
export interface Brief {
  prompt: string;
  requiredText: string[];
  width: number;
  height: number;
}

/** Art direction per template (FR-2.3). Prose, not keywords: image models
 *  follow described scenes far more reliably than comma-separated tags. */
const STYLE_DIRECTION: Record<StyleTemplate, string> = {
  festive:
    'Warm festive Indian celebration. Soft diya glow, marigold and rangoli motifs framing the edges, ' +
    'rich saturated colour, gentle golden bokeh in the background.',
  minimal_luxury:
    'Minimal luxury editorial. Generous negative space, muted neutral backdrop, single soft key light, ' +
    'restrained elegant composition, no clutter or ornament.',
  bold_discount:
    'High-energy retail promotion. Strong colour blocking, bold geometric shapes, high contrast, ' +
    'the offer treated as the dominant visual element.',
  flat_lay_product_hero:
    'Overhead flat-lay product hero. Product centred on a clean surface, even diffused lighting, ' +
    'a few tasteful complementary props at the edges, crisp shadows.',
};

const TONE_DIRECTION: Record<ToneOfVoice, string> = {
  friendly: 'approachable and warm',
  premium: 'refined, understated, premium',
  playful: 'lively and playful',
  traditional: 'classic and traditional',
};

const CAMPAIGN_INTENT: Record<CampaignType, string> = {
  offer: 'a limited-time promotional offer',
  launch: 'a new product launch',
  festival: 'a festival campaign',
  generic: 'general brand awareness',
};

/**
 * Stage 1 — brief. Turns the structured intake plus the Brand Kit into the
 * generation prompt. The user never writes a prompt (FR-2.3), so all prompt
 * craft lives here.
 *
 * Deterministic templating rather than an LLM-composed brief: it is
 * reproducible, costs nothing, and cannot fail partway through a paid pipeline.
 * The registry's `orchestrator` role is described as covering brief
 * composition, so routing this through the LLM is a deliberate future option —
 * worth doing only once there is output to compare it against.
 */
export async function composeBrief(ctx: StageContext): Promise<Brief> {
  const { brand, request } = ctx;
  const { width, height, printIntent } = OUTPUT_FORMAT_DIMENSIONS[request.outputFormat];

  const [product] = await ctx.db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, request.productId))
    .limit(1);

  if (!product) throw new Error(`Product ${request.productId} not found`);

  // Ordered most- to least-important: the offer is the reason the ad exists,
  // the CTA is the smallest element.
  const requiredText = [request.headlineText, request.offerText, request.ctaText].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  // Descriptions are free text and may or may not be punctuated; normalise so
  // the composed sentence never ends up with ".." or a dangling clause.
  const description = product.description?.trim().replace(/[.\s]+$/, '');

  const lines = [
    `Design a ${printIntent ? 'print-ready poster' : 'social media creative'} at ${width}x${height} pixels for "${brand.name}"${
      brand.category ? `, ${brand.category}` : ''
    }.`,
    '',
    `Campaign: ${CAMPAIGN_INTENT[request.campaignType]}.`,
    `Product: ${product.name}${description ? ` — ${description}` : ''}.`,
    brand.audience ? `Audience: ${brand.audience}.` : '',
    '',
    `Art direction: ${STYLE_DIRECTION[request.styleTemplate]}`,
    `Overall feel: ${TONE_DIRECTION[brand.toneOfVoice]}.`,
    brand.colors.length ? `Use the brand palette: ${brand.colors.join(', ')}.` : '',
    '',
    // FR-3.1: the whole point is the customer's actual product, not a
    // plausible-looking substitute.
    'Feature the exact product shown in the reference image. Reproduce its shape, colour, material, and',
    'pattern faithfully. Do not substitute, restyle, or invent a different product.',
  ];

  if (requiredText.length) {
    lines.push(
      '',
      // FR-3.5 exists because models mangle on-image text; the QA stage reads it
      // back. Being explicit here reduces how often that retry is needed.
      'Render the following text on the image, spelled exactly as written, large and clearly legible:',
      ...requiredText.map((text) => `  "${text}"`),
      'Keep the text inside the safe area with calm space around it. Do not add any other words,',
      'letterforms, watermarks, or signatures.',
    );
  } else {
    lines.push('', 'Do not render any text, letterforms, or watermarks on the image.');
  }

  if (request.language && request.language !== 'en') {
    lines.push('', `Any on-image text must be rendered in language code "${request.language}".`);
  }

  if (printIntent) {
    lines.push(
      '',
      'This is for print: keep critical content away from the outer 5% and favour crisp, high-contrast edges.',
    );
  }

  // FR-2.4: an escape hatch, deliberately last so it refines the brief rather
  // than competing with the brand rules above it.
  if (request.extraInstructions?.trim()) {
    lines.push('', `Additional direction from the customer: ${request.extraInstructions.trim()}`);
  }

  return { prompt: lines.filter((line) => line !== '').join('\n'), requiredText, width, height };
}

export interface GeneratedVariant {
  storageKey: string;
  width: number;
  height: number;
  provider: string;
  model: string;
}

/** Generation is the slow stage — the PRD budgets up to two minutes — but a
 *  provider that accepts the connection and stalls must not hold a worker slot
 *  forever. Concurrency is 2, so two stalled calls would halt the queue. */
const IMAGE_TIMEOUT_MS = 180_000;

const MEDIA_TYPE_BY_EXT: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function mediaTypeFor(key: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  return MEDIA_TYPE_BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg';
}

/**
 * CLAUDE.md rule 5: every provider call records cost. Adapters hand the cost
 * back in the same object as the result precisely so this cannot be forgotten.
 */
async function recordCost(ctx: StageContext, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId: ctx.brand.id,
    system: 'content',
    referenceId: ctx.jobId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

/**
 * Stage 2 — image. Fans out `variantCount` variants through
 * `ai.imageGenerator()`, conditioned on the cleaned product photos and logo.
 *
 * Which adapter serves this is a registry concern (IMAGE_PROVIDER_PRIMARY);
 * nothing here knows whether it is talking to Gemini or the local stub.
 */
export async function generateImages(
  ctx: StageContext,
  brief: Brief,
): Promise<GeneratedVariant[]> {
  const rows = await ctx.db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, ctx.request.productId));

  // Prefer the background-removed variant when the asset-prep step has run
  // (FR-3.6): a cleaned cut-out conditions the model far better than a photo
  // with a busy background competing for attention.
  const references = await Promise.all(
    rows.map(async (row) => {
      const key = row.cleanedStorageKey ?? row.storageKey;
      return {
        data: await ctx.storage.get(key),
        mediaType: mediaTypeFor(key),
        label: row.isPrimary ? 'primary product photo' : 'product photo',
      };
    }),
  );

  if (references.length === 0) {
    // FR-3.1 wants the customer's real product in the frame. Nothing writes
    // content.product_images yet — there is no upload route — so this is
    // expected today and must not block the pipeline.
    console.warn(
      `[content:image] job ${ctx.jobId}: no product images; generating without visual conditioning`,
    );
  }

  const generator = ctx.ai.imageGenerator();

  const { value: images, cost } = await withRetry(
    () =>
      withTimeout(
        generator.generate(
          {
            prompt: brief.prompt,
            references,
            width: brief.width,
            height: brief.height,
            count: ctx.request.variantCount,
            requiredText: brief.requiredText,
            brandColors: ctx.brand.colors,
          },
          { referenceId: ctx.jobId, brandId: ctx.brand.id },
        ),
        IMAGE_TIMEOUT_MS,
        'image:generate',
      ),
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[content:image] job ${ctx.jobId}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    },
  );

  await recordCost(ctx, cost);

  return Promise.all(
    images.map(async (image, index) => {
      const key = creativeKey(
        ctx.brand.id,
        ctx.jobId,
        index + 1,
        image.mediaType === 'image/jpeg' ? 'jpg' : 'png',
      );
      await ctx.storage.put(key, image.data, image.mediaType);
      return {
        storageKey: key,
        width: image.width,
        height: image.height,
        provider: generator.provider,
        model: image.model,
      };
    }),
  );
}

export interface CheckedVariant extends GeneratedVariant {
  /** False only when the readback ran and disagreed with the brief. */
  passed: boolean;
  detectedText: string;
  /** Distinguishes "verified and correct" from "never verified". */
  checked: boolean;
  notes?: string;
}

/** Compared case- and punctuation-insensitively: a model rendering "30% OFF"
 *  as "30% Off" is correct, and the readback's own transcription varies. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9%]+/g, '');
}

/**
 * Stage 3 — QA. Reads on-image text back with a vision model and flags
 * misspellings (FR-3.5). Also the natural home for the programmatic
 * logo-overlay fallback (FR-3.4) when the model mangles the logo.
 *
 * Advisory, never fatal: a QA outage must not fail a generation the customer
 * has already been charged for. A variant that could not be checked is marked
 * `checked: false` and passed through rather than rejected.
 *
 * TODO(content): FR-3.5 also asks for one automatic regeneration when the
 * readback fails. Left out deliberately — it doubles worst-case spend per job,
 * so it wants a cost ceiling agreed before it goes in.
 * TODO(content): FR-3.4 logo-overlay fallback with sharp.
 */
export async function qaImages(
  ctx: StageContext,
  variants: GeneratedVariant[],
  brief: Brief,
): Promise<CheckedVariant[]> {
  // Nothing was asked to appear, so there is nothing to read back.
  if (brief.requiredText.length === 0) {
    return variants.map((variant) => ({
      ...variant,
      passed: true,
      detectedText: '',
      checked: false,
      notes: 'no on-image text requested',
    }));
  }

  return Promise.all(
    variants.map(async (variant) => {
      try {
        const data = await ctx.storage.get(variant.storageKey);
        const { value: detectedText, cost } = await withTimeout(
          ctx.ai.llm().analyzeImage(
            {
              role: 'qa',
              prompt:
                'Transcribe every piece of text visible in this image, exactly as rendered, ' +
                'including any misspellings. Reply with the text only, one item per line. ' +
                'If there is no text, reply with NONE.',
              images: [{ data, mediaType: mediaTypeFor(variant.storageKey) }],
            },
            { referenceId: ctx.jobId, brandId: ctx.brand.id },
          ),
          60_000,
          'image:qa',
        );

        await recordCost(ctx, cost);

        const haystack = normalise(detectedText);
        const missing = brief.requiredText.filter((text) => !haystack.includes(normalise(text)));

        return {
          ...variant,
          passed: missing.length === 0,
          detectedText,
          checked: true,
          ...(missing.length ? { notes: `missing or misspelled: ${missing.join(', ')}` } : {}),
        };
      } catch (error) {
        console.warn(
          `[content:qa] job ${ctx.jobId}: readback failed for ${variant.storageKey} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {
          ...variant,
          passed: true,
          detectedText: '',
          checked: false,
          notes: 'qa readback unavailable',
        };
      }
    }),
  );
}

/**
 * The output format the customer chose implies where the creative is going, and
 * copy conventions differ per destination (FR-4.2). There is no separate
 * platform field on CreativeRequest, so it is derived rather than asked for
 * twice. A print poster has no native platform; WhatsApp is the closest fit for
 * how an SMB actually circulates one.
 */
const PLATFORM_BY_FORMAT: Record<OutputFormat, Platform> = {
  instagram_post: 'instagram',
  story_reel_cover: 'instagram',
  facebook_banner: 'facebook',
  poster_a4: 'whatsapp',
};

/** Derived from the shared contract so the prompt and the validation can never
 *  drift apart. The model picks the words; platform and language are ours. */
const copyDraftSchema = copyPackSchema.omit({ platform: true, language: true });
const COPY_JSON_SCHEMA = z.toJSONSchema(copyDraftSchema) as Record<string, unknown>;

/**
 * Stage 4 — copy. Generates the platform-aware copy pack in the Brand Kit's
 * tone (FR-4.1, FR-4.2). Runs on the `volume` model role since it fans out per
 * platform and is the cheapest stage to get wrong-and-retry.
 */
export async function generateCopy(ctx: StageContext): Promise<CopyPack[]> {
  const { brand, request } = ctx;
  const platform = PLATFORM_BY_FORMAT[request.outputFormat];

  const [product] = await ctx.db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, request.productId))
    .limit(1);

  if (!product) throw new Error(`Product ${request.productId} not found`);

  const handle = brand.socialHandles[platform];

  const { value: draft, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson(
          {
            role: 'volume',
            system:
              `You write marketing copy for ${brand.name}, ` +
              `${brand.category ?? 'a small business'}. ` +
              `Voice: ${TONE_DIRECTION[brand.toneOfVoice]}. ` +
              'Write for a real small business owner, not a marketing agency. ' +
              'No emoji spam, no invented claims, no pricing you were not given.',
            messages: [
              {
                role: 'user',
                content: [
                  `Write a ${platform} copy pack for ${CAMPAIGN_INTENT[request.campaignType]}.`,
                  `Product: ${product.name}${product.description ? ` — ${product.description}` : ''}.`,
                  brand.audience ? `Audience: ${brand.audience}.` : '',
                  request.headlineText ? `The creative shows the headline "${request.headlineText}".` : '',
                  request.offerText ? `The offer is "${request.offerText}".` : '',
                  handle ? `The brand's ${platform} handle is ${handle}.` : '',
                  `Write in language code "${request.language}".`,
                  'Return 8 to 15 hashtags, each starting with #.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            schema: COPY_JSON_SCHEMA,
            parse: (raw) => copyDraftSchema.parse(raw),
          },
          { referenceId: ctx.jobId, brandId: ctx.brand.id },
        ),
        60_000,
        'copy:generate',
      ),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[content:copy] job ${ctx.jobId}: attempt ${attempt} failed, retrying in ${delayMs}ms`,
        ),
    },
  );

  await recordCost(ctx, cost);

  return [{ ...draft, platform, language: request.language }];
}
