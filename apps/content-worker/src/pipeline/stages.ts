import { describeError, withRetry, withTimeout, type AiRegistry } from '@bmas/ai';
import { eq, schema, type Brand, type Database } from '@bmas/db';
import {
  OUTPUT_FORMAT_DIMENSIONS,
  copyPackSchema,
  normaliseHashtags,
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
  studio_white:
    'Clean e-commerce studio shot. Seamless pure white backdrop, soft even three-point lighting, ' +
    'a subtle contact shadow under the product, no props and no scenery. Catalogue-accurate colour.',
  lifestyle_in_use:
    'Candid lifestyle scene with the product genuinely in use in its natural setting. ' +
    'Shallow depth of field, natural light, authentic unposed moment. The product stays in sharp focus ' +
    'and remains unmistakably the subject.',
  bold_typographic:
    'Typography-led poster design. A strong graphic layout carries the message, the product sits within ' +
    'a confident grid, flat brand-coloured shapes, generous margins, editorial poster feel.',
  tech_dark_gradient:
    'Modern tech product launch. Deep charcoal-to-black gradient backdrop, crisp rim lighting tracing the ' +
    "product's edges, subtle lens flare and a soft reflective floor. Sleek, precise and premium.",
  neon_gaming:
    'High-energy gaming aesthetic. Dark scene lit by saturated neon cyan and magenta accents, glowing rim ' +
    'light, faint volumetric haze and a hint of circuitry or grid in the background. Bold and electric.',
  outdoor_natural_light:
    'Bright outdoor daylight. Golden-hour sun, natural greenery or open sky behind, soft organic shadows, ' +
    'airy and fresh with a relaxed real-world feel.',
  vintage_retro:
    'Retro print advertisement. Muted warm-washed palette, subtle paper grain and halftone texture, ' +
    'mid-century layout, gently faded edges as though scanned from an old magazine.',
  playful_pastel:
    'Playful pastel studio scene. Soft candy-coloured backdrop, rounded geometric props and podiums, ' +
    'bright even lighting, cheerful and youthful with a light bouncy composition.',
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
    `Campaign type: ${CAMPAIGN_INTENT[request.campaignType]}.`,
    `Product: ${product.name}${description ? ` — ${description}` : ''}.`,
    brand.audience ? `Target audience: ${brand.audience}.` : '',
    '',
    '**Visual Style:**',
    `Art direction: ${STYLE_DIRECTION[request.styleTemplate]}`,
    `Brand voice: ${TONE_DIRECTION[brand.toneOfVoice]}.`,
    brand.colors.length ? `Use the brand colour palette: ${brand.colors.join(', ')}.` : '',
    '',
    '**Product Presentation (Critical):**',
    'Feature the exact product shown in the reference image as the HERO element.',
    'Reproduce its shape, colour, texture, material, and pattern EXACTLY and FAITHFULLY.',
    'Do NOT substitute, restyle, modernise, or invent a different product.',
    'Centre or prominently position the product where the viewer\'s eye lands first.',
    // The brand line above names the shop's usual trade, and the model will
    // happily stage the product on top of it — a pair of headphones resting on
    // a folded saree, because the brand is a saree boutique. Staging has to
    // follow the product, not the shopfront.
    `Every prop, surface and background element must plausibly belong with a ${product.name} specifically.`,
    "Do NOT introduce merchandise from the brand's other categories as props or set dressing.",
    'Show exactly one product. Do not add extra units, variants or unrelated items beside it.',
    '',
    '**Reference Image Integration:**',
    'The reference image shows the actual product. Use it as the truth.',
    'If reference shows product detail (weave, embroidery, finish), highlight that.',
    'If reference shows multiple items, compose them together naturally.',
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
          `[content:image] job ${ctx.jobId}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
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
 *
 * Enhanced to generate contextual hashtags based on product category, brand
 * values, audience, and campaign type rather than hardcoded templates.
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

  const handle =
    brand.socialHandles[platform] ??
    brand.socialHandles.instagram ??
    (brand.name ? `@${brand.name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '')}` : undefined);

  // Platform-specific hashtag guidance. Deliberately free of worked examples:
  // an earlier version illustrated the rule with saree tags, and the model
  // copied them onto every product it was given, headphones included.
  const platformGuidance: Record<Platform, string> = {
    instagram:
      'Use trending hashtags (#); Instagram users discovery-search by tags. Mix popular (100k+) and niche (<10k).',
    facebook:
      'Use 5–10 relevant hashtags; Facebook hashtags are less critical than Instagram but still help reach.',
    whatsapp:
      'Use 3–5 hashtags for searchability within WhatsApp Business; keep them concise and product-related.',
  };

  const productLine = `${product.name}${product.description ? ` — ${product.description}` : ''}`;

  const { value: draft, cost } = await withRetry(
    () =>
      withTimeout(
        ctx.ai.llm().generateJson(
          {
            role: 'volume',
            system:
              // The product leads and the brand supplies the voice. Stated in
              // that order and that plainly because the reverse — brand first,
              // product buried in the user turn — produced copy about the
              // shop's usual catalogue and ignored the item being advertised.
              `You are writing about one specific product: ${productLine}. ` +
              'Every sentence, and every hashtag, must be about THAT product. ' +
              `It is sold by ${brand.name}, a ${brand.category ?? 'small business'}, ` +
              'whose name, voice and handle you should use. ' +
              (brand.audience ? `They serve: ${brand.audience}. ` : '') +
              `Voice: ${TONE_DIRECTION[brand.toneOfVoice]}. ` +
              // Real catalogues are mixed; a saree shop may also sell gadgets.
              "If the product does not fit the shop's usual category, follow the " +
              'product and never describe it as something it is not. ' +
              'Write for real customers, not marketers. ' +
              'Be authentic, avoid hype. ' +
              'No fake claims, no emoji spam, no pricing you were not given.',
            messages: [
              {
                role: 'user',
                content: [
                  `Create a ${platform} copy pack for a ${CAMPAIGN_INTENT[request.campaignType]} campaign.`,
                  '',
                  '**The product being advertised:**',
                  `${productLine}.`,
                  'This is the subject. The headline, the caption and every hashtag describe THIS item.',
                  '',
                  '**Context:**',
                  brand.audience
                    ? `Audience: ${brand.audience}.`
                    : 'Audience: Conscious consumers who value quality.',
                  request.headlineText ? `Headline on image: "${request.headlineText}".` : '',
                  request.offerText ? `Special offer: "${request.offerText}".` : '',
                  request.extraInstructions?.trim()
                    ? `Extra direction from the customer: ${request.extraInstructions.trim()}`
                    : '',
                  '',
                  `**Platform (${platform}):**`,
                  platformGuidance[platform],
                  handle ? `Brand handle to mention: ${handle}` : '',
                  '',
                  // Described by role rather than by example. Concrete sample
                  // tags get copied verbatim regardless of what is being sold.
                  '**Hashtag strategy:**',
                  `- 3-4 naming the product itself and what it is (its type, category, key feature).`,
                  '- 2-3 for the people who would buy it, or the occasion they would use it for.',
                  '- 2-3 for the campaign or a current trend, only where genuinely relevant.',
                  `- Total: 8-12 hashtags for ${platform}.`,
                  '- Derive every tag from the product described above. Do not reuse tags from any',
                  '  example, and do not tag a category this product does not belong to.',
                  '',
                  `Write in language: ${request.language}.`,
                  'Return valid JSON with headline, caption, hashtags (array of strings), and cta.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            schema: COPY_JSON_SCHEMA,
            parse: (raw) => {
              const draft = copyDraftSchema.parse(raw);
              return { ...draft, hashtags: normaliseHashtags(draft.hashtags) };
            },
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
