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
  type SiteAnalysis,
  type StyleTemplate,
  type ToneOfVoice,
} from '@bmas/shared';
import { z } from 'zod';
import sharp from 'sharp';
import { creativeKey, thumbnailKey, type Storage } from '../storage.js';

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
  /** The brand's website, read once at setup and confirmed by the user
   *  (FR-1.4). Null when no site was imported, the import failed, or the user
   *  applied the Brand Kit fields without opting the art direction in — the
   *  loader resolves all three to the same thing so no stage has to ask. */
  siteIdentity?: SiteAnalysis | null;
  /** Storage key for the brand's logo, set only once the user has opted it
   *  into generation. The image stage passes the bytes as conditioning and the
   *  brief switches from "invent no logo" to "reproduce this one". */
  logoStorageKey?: string | null;
  /** Brand photography to condition on for treatment only. Opt-in and
   *  deliberately separate from the logo — a photograph carries subject
   *  matter, and that is exactly what must not leak into the creative. */
  styleReferenceKeys?: string[];
  /** The brand's most recent Trend Research result, if any (automatic,
   *  best-effort — see `loadTrendContext` in generate.ts). Only reaches the
   *  brief for the 'trend' variant in a diverse-mode generation; null
   *  otherwise, same "resolve once, no stage has to ask" shape as
   *  `siteIdentity`. */
  trendContext?: TrendContext | null;
}

/** Which extra knowledge source a variant's brief draws on, when a job runs
 *  in 'diverse' mode (`request.variantMode === 'diverse'`). Undefined means
 *  today's original uniform-mode path — one shared brief, no extra source. */
export type VariantKind = 'trend' | 'website' | 'clean';

/** Fixes each kind to its own storage-key slot so the three diverse variants,
 *  generated with three parallel `count: 1` calls, never collide on a key —
 *  the uniform path's array-index numbering doesn't apply here since each
 *  call only ever sees an array of length 1. */
export const VARIANT_SLOT_INDEX: Record<VariantKind, number> = {
  trend: 1,
  website: 2,
  clean: 3,
};

export interface TrendContext {
  title: string;
  summary: string;
  recommendation: string;
}

/**
 * Trims a caption-length line down to something an image model can actually
 * set as type. Typography degrades badly past a few words, and the copy stage
 * writes for a feed — "Journey Through the Sacred Hills: Uttarakhand with
 * @desiwanderer" is a fine caption and an unreadable poster headline. Keeps the
 * first clause, cuts on a word boundary, drops trailing punctuation.
 */
const TRAILING_FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
  'with', 'by', 'your', 'our', 'their', 'its', 'this', 'that', 'is', 'are', '&',
]);

function posterPhrase(value: string | undefined, maxChars: number): string | undefined {
  const first = value?.split(/[:—–|.!?\n]/)[0]?.trim().replace(/[,;\s]+$/, '');
  if (!first) return undefined;

  let phrase = first;
  if (phrase.length > maxChars) {
    // Sample one character past the limit: cutting at exactly maxChars and then
    // seeking back to the last space discards a whole word whenever the phrase
    // already ended on a boundary there ("Reserve your Uttarakhand" -> "Reserve
    // your").
    const window = phrase.slice(0, maxChars + 1);
    const boundary = window.lastIndexOf(' ');
    phrase = boundary > 0 ? window.slice(0, boundary) : phrase.slice(0, maxChars);

    // Half a subordinate clause reads worse than dropping it: prefer ending on
    // the comma ("Handwoven Banarasi Silk, Made" -> "Handwoven Banarasi Silk").
    const comma = phrase.lastIndexOf(',');
    if (comma > 0) phrase = phrase.slice(0, comma);
  }

  // Truncation strands prepositions and articles ("...Serene Meadows of"),
  // which reads as a typo once it is set in 60pt on a finished advertisement.
  const words = phrase.split(/\s+/);
  for (let last = words[words.length - 1]; words.length > 1 && last; last = words[words.length - 1]) {
    if (!TRAILING_FILLER.has(last.toLowerCase())) break;
    words.pop();
  }

  return words.join(' ').replace(/[,;\s]+$/, '') || undefined;
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
  elegant: 'graceful and refined',
};

/** `brand.tone` can hold more than one register at once (Task 7); this blends
 *  them into one direction. Falls back to `friendly` rather than emitting
 *  "undefined" if a row somehow holds a value outside the known set. */
function toneDirection(tone: readonly string[]): string {
  const known = tone
    .map((value) => TONE_DIRECTION[value as ToneOfVoice])
    .filter((direction): direction is string => Boolean(direction));
  return known.length ? known.join(', ') : TONE_DIRECTION.friendly;
}

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
export async function composeBrief(
  ctx: StageContext,
  copy?: CopyPack,
  variantKind?: VariantKind,
): Promise<Brief> {
  const { brand, request } = ctx;
  const { width, height, printIntent } = OUTPUT_FORMAT_DIMENSIONS[request.outputFormat];

  // Uniform mode (no `variantKind`) keeps today's exact behaviour: the site
  // identity block runs whenever one is applied, no trend block ever runs.
  // In diverse mode each variant draws on at most one extra source — 'trend'
  // gets the trend block instead of the site block, 'clean' gets neither.
  const siteIdentity = !variantKind || variantKind === 'website' ? ctx.siteIdentity : null;
  const trend = variantKind === 'trend' ? ctx.trendContext : null;

  const [product] = await ctx.db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, request.productId))
    .limit(1);

  if (!product) throw new Error(`Product ${request.productId} not found`);

  // What the customer typed always wins; the copy stage fills the gaps so an
  // ad is never shipped as a bare photograph with no message on it.
  const headline = request.headlineText?.trim() || posterPhrase(copy?.headline, 42);
  const offer = request.offerText?.trim() || undefined;
  const wordmark = brand.name?.trim() || undefined;
  const cta = request.ctaText?.trim() || posterPhrase(copy?.cta, 28);

  // Ordered most- to least-important: the headline is read first, the CTA is
  // the smallest element. QA reads every one of these back off the image.
  const requiredText = [headline, offer, wordmark, cta].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  // Descriptions are free text and may or may not be punctuated; normalise so
  // the composed sentence never ends up with ".." or a dangling clause.
  const description = product.description?.trim().replace(/[.\s]+$/, '');

  // The image stage conditions on these; the brief has to know whether any
  // exist, because instructions written for a reference photo ("reproduce the
  // product exactly as shown") are actively harmful when there is nothing to
  // reproduce — the model fills the gap from the brand's category instead.
  const [reference] = await ctx.db
    .select({ id: schema.productImages.id })
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, request.productId))
    .limit(1);
  const hasReference = Boolean(reference);

  // `null` marks a line that does not apply and is dropped below; '' is a real
  // blank line and survives, so the sections stay legible to the model.
  const lines: Array<string | null> = [
    `Design a professional ${printIntent ? 'print-ready advertising poster' : 'social media advertisement'} at ${width}x${height} pixels.`,
    '',
    '**Subject — this governs everything below:**',
    `The advertisement is for: ${product.name}${description ? ` — ${description}` : ''}.`,
    product.sellingPoints.length
      ? `Its key selling points: ${product.sellingPoints.join(', ')}. Make these visually evident where the composition allows (e.g. a material or craft claim should be legible in the surface detail) rather than stating them as text.`
      : null,
    `Campaign type: ${CAMPAIGN_INTENT[request.campaignType]}.`,
    `${product.name} is the single subject of the image. Every element in the frame must exist to sell it.`,
    // A product can be a service or an experience ("Uttarakhand trip"), which
    // has no object to photograph. Left unsaid, the model reaches for the
    // brand's category and photographs that instead.
    `If ${product.name} is a service, trip, or experience rather than a physical object, depict the experience itself — the place, the moment, the outcome the customer is buying. Do not invent a physical object to stand in for it.`,
    '',
    '**Brand context — styling only:**',
    `Brand name: ${brand.name}.`,
    // Deliberately fenced off. The category describes what the shop usually
    // sells, which is frequently not what this particular ad is selling; left
    // unqualified the model stages the catalogue instead of the product (a
    // travel package rendered as a woman in a saree, because the brand row
    // still reads "saree boutique").
    brand.category
      ? `The brand's usual trade is "${brand.category}". Use this only to judge tone. Do NOT place its merchandise, stock, or typical subject matter in this image unless ${product.name} genuinely is one of those things.`
      : null,
    brand.audience ? `Who this is for: ${brand.audience}. Let this inform styling, not the subject.` : null,
    `Brand voice: ${toneDirection(brand.tone)}.`,
    brand.colors.length
      ? `Work the brand colours (${brand.colors.join(', ')}) into the palette as accents. Do not let them dictate what appears in the scene.`
      : null,
    '',
    '**Art direction:**',
    STYLE_DIRECTION[request.styleTemplate],
    // FR-1.4. Placed after the style template, and explicitly subordinate to
    // it: the template is what the customer chose for *this* campaign, while
    // the website is the brand's standing look. A brand whose site is muted
    // and editorial can still ask for a bold discount poster, and getting that
    // precedence backwards would quietly ignore the control they just used.
    //
    // Fenced as hard as `brand.category` above, and for the same reason. This
    // block is the largest piece of brand context in the prompt, so it is also
    // the most capable of hijacking the subject — the analyser is instructed
    // never to name the site's merchandise, and this is the second guard.
    ...(siteIdentity
      ? [
          '',
          "**The brand's own visual identity, read from their website:**",
          siteIdentity.visualIdentity,
          '',
          // Broken out rather than left as one paragraph: each of these governs
          // a different decision the model makes, and a single blob gets
          // skimmed. Palette proportion in particular was invisible before —
          // hex codes say which colours, never how much of each.
          `Colour: ${siteIdentity.colorUsage}`,
          `Typography: ${siteIdentity.typography}`,
          `Photographic treatment: ${siteIdentity.imageryStyle}`,
          `Character: ${siteIdentity.brandPersonality}`,
          '',
          'Apply all of the above to palette, typography, lighting and finish so the advertisement is recognisably theirs.',
          'Where it conflicts with the art direction above, the art direction wins.',
          `This describes styling only. It must not change what is depicted — the subject is still ${product.name} and nothing else, even if the brand's website is about something different.`,
        ]
      : []),
    // The 'trend' variant's counterpart to the site-identity block above —
    // same fencing convention, same reasoning: a current event or trend is
    // context for occasion/mood/angle, never license to change the subject.
    ...(trend
      ? [
          '',
          '**A current trend or event worth tying this campaign to:**',
          trend.title,
          trend.summary,
          `Suggested angle: ${trend.recommendation}`,
          '',
          'Use this only to inform mood, setting, styling, or occasion — a seasonal cue, an event tie-in, a cultural moment happening right now.',
          'Where it conflicts with the art direction above, the art direction wins.',
          `This describes context only. It must not change what is depicted — the subject is still ${product.name} and nothing else, even if the trend itself is about something different.`,
        ]
      : []),
    '',
    '**Craft — this is a paid advertisement, hold it to that bar:**',
    'Commercial advertising photography: deliberate lighting, correct exposure, sharp focus on the subject, believable materials and surfaces.',
    'One clear focal point, a composition that reads instantly at thumbnail size, and calm negative space where text can sit.',
    'Colour-graded and finished like a published campaign, not a raw snapshot or a stock-photo collage.',
    '',
    '**Do not:**',
    // The brand name is rendered further down as type; what is banned here is
    // the model drawing an emblem or a shopfront sign of its own invention.
    // With a real logo attached the ban has to be narrowed, or it reads as
    // contradicting the instruction to place that logo.
    ctx.logoStorageKey
      ? "Do not invent logo marks, emblems, packaging labels, or shop signage. The only mark permitted is the brand's actual logo, attached below."
      : 'Do not invent logo marks, emblems, packaging labels, or shop signage.',
    'Do not add unrelated products, extra units, or filler props that do not serve the subject.',
    'Do not include people unless the art direction above calls for a person; when a person does appear, hands, faces and proportions must be anatomically correct.',
    'No watermarks, no borders, no UI overlays, no collage or split-screen layouts.',
    // Hard constraint, not styling — a brand sets this to keep specific subjects
    // out of its advertising entirely, unconditionally.
    brand.bannedTopics.length
      ? `Do not depict or reference, in any form: ${brand.bannedTopics.join(', ')}. This overrides every other instruction above if they would conflict.`
      : null,
    '',
    // Named before the photograph section so the model has been told what each
    // attachment is before it is asked to use any of them. Several images
    // arrive in one call with only their labels to tell them apart, and an
    // unexplained logo gets treated as another product photo.
    ...(ctx.logoStorageKey
      ? [
          "**The brand's logo is attached:**",
          `It is labelled "the brand's logo". Reproduce it exactly as supplied — its shapes, proportions and lettering — and do not redraw, restyle, recolour or translate it.`,
          'Place it once, small, in a corner or margin where it sits clear of the subject and of the text, at a size a viewer reads as a signature rather than as the headline.',
          'It is the brand mark, not the subject. Do not enlarge it, repeat it, or build the composition around it.',
          '',
        ]
      : []),
    ...(ctx.styleReferenceKeys?.length
      ? [
          "**Style references are attached (the brand's own photography):**",
          'They are labelled as style references. Read them for treatment ONLY: lighting, colour grade, depth of field, staging density, how much air the composition carries.',
          `Do NOT reproduce anything shown in them. The objects, people, garments, settings and products in those images are not part of this advertisement — the subject is ${product.name} and nothing else.`,
          'If a style reference shows a product, that product must not appear in your output in any form.',
          '',
        ]
      : []),
    ...(hasReference
      ? [
          '**Reference photograph:**',
          `A photograph supplied by the customer is attached, labelled "reference photograph". It is the source of truth for the subject — read what it actually shows before using it.`,
          // A reference is not always a product shot. For a trip or a service it
          // is usually the destination, and demanding the "product" be extracted
          // from it is what makes the model invent one from the brand's trade.
          `If it shows ${product.name} itself, reproduce that item exactly — its shape, colour, texture, material and pattern. Do not substitute, restyle or modernise it, and keep fine detail (weave, embroidery, finish, hardware) legible.`,
          `If instead it shows a place, setting or scene rather than an object, treat it as the location and mood for this advertisement. Depict that setting. Do NOT invent a physical product to place into it.`,
          'If it shows several items, compose them together naturally as one arrangement.',
        ]
      : [
          // No photo to anchor on, so the description is the only truth. Saying
          // so keeps the model from treating the brand line as the brief.
          '**No reference photograph was supplied:**',
          `Depict ${product.name} as described above and nothing else. Base it strictly on that description — do not infer the subject from the brand's trade.`,
          'Keep the depiction generic and plausible rather than inventing specific branding or model numbers.',
        ]),
  ];

  if (requiredText.length) {
    lines.push(
      '',
      // FR-3.5 exists because models mangle on-image text; the QA stage reads it
      // back. Naming each line's role and rank, rather than listing them flat,
      // is what gets a designed hierarchy instead of four equal-weight labels.
      '**Text on the image — this is an advertisement, the words are part of the design:**',
      'Render exactly the following, spelled character-for-character as written:',
      headline ? `  HEADLINE — largest element, the first thing read: "${headline}"` : null,
      offer ? `  OFFER — second most prominent, visually emphasised: "${offer}"` : null,
      wordmark ? `  BRAND NAME — set as clean typography, a wordmark: "${wordmark}"` : null,
      cta ? `  CALL TO ACTION — smallest, clearly separated from the rest: "${cta}"` : null,
      'Lay them out with an obvious size hierarchy in that order.',
      'Integrate the type into the composition — sitting in the negative space, aligned to a shared grid, with generous margins — rather than pasted flat across the subject.',
      // The identity block above describes the brand's letterforms in prose,
      // which is the only form an image model can act on — it cannot load a
      // font. Pointing at it here matters because the typography direction is
      // otherwise several hundred words upstream of the text instructions.
      siteIdentity
        ? "Set the type in the letterforms described in the brand's visual identity above, so the wordmark and headline match how the brand sets type elsewhere. Legibility comes first: if that description would not read at this size, favour a clear typeface of the same character."
        : null,
      'Use one legible typeface family with strong contrast against whatever sits behind it. Every character must be crisp, correctly formed and correctly spelled.',
      'Do not add any other words, letterforms, taglines, watermarks, signatures, URLs, or prices you were not given.',
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

  const prompt = lines.filter((line): line is string => line !== null).join('\n');
  return { prompt, requiredText, width, height };
}

/** What the image adapter conditions on: the product's reference photographs. */
interface ImageReference {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  label: string;
}

export interface GeneratedVariant {
  storageKey: string;
  /** Null when thumbnailing failed; callers fall back to the full-size asset. */
  thumbnailStorageKey: string | null;
  width: number;
  height: number;
  provider: string;
  model: string;
  /** Set by the diverse-mode caller in generate.ts; absent in uniform mode. */
  variantKind?: VariantKind;
}

/** Generation is the slow stage, but a provider that accepts the connection and
 *  stalls must not hold a worker slot forever. Concurrency is 2, so two stalled
 *  calls would halt the queue.
 *
 *  This is the outer backstop: the adapter enforces a tighter per-request
 *  budget by tier and fails cleanly, so reaching this value means the call hung
 *  in a way the SDK's own timeout did not catch. It therefore has to clear the
 *  slowest legitimate case by a margin — three concurrent 4K variants for
 *  poster_a4, measured at 232–257s. The old 180s sat below that, so raising the
 *  adapter's ceiling alone would only have moved where A4 died. */
const IMAGE_TIMEOUT_MS = 360_000;

/** Long edge of the gallery thumbnail. The grid renders at roughly 160pt on a
 *  3x phone screen, so 480px covers it without shipping a megabyte per tile. */
const THUMBNAIL_LONG_EDGE = 480;
const THUMBNAIL_QUALITY = 78;

const MEDIA_TYPE_BY_EXT: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function mediaTypeFor(key: string): 'image/png' | 'image/jpeg' | 'image/webp' {
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
  variantKind?: VariantKind,
): Promise<GeneratedVariant[]> {
  const references = await loadReferences(ctx, variantKind);

  if (references.length === 0) {
    // FR-3.1 wants the customer's real product in the frame. Products can be
    // created without photos, so this is a quality warning, not an error.
    console.warn(
      `[content:image] job ${ctx.jobId}: no product images; generating without visual conditioning`,
    );
  }

  // Diverse mode: one image per call, at this kind's fixed slot — the caller
  // in generate.ts runs the three kinds in parallel, and each needs its own
  // storage key so they cannot collide. Uniform mode is unchanged: one call
  // fans out to `variantCount` images, numbered by array position.
  const variants = variantKind
    ? await renderVariants(ctx, brief, references, 1, (_index, ext) =>
        creativeKey(ctx.brand.id, ctx.jobId, VARIANT_SLOT_INDEX[variantKind], ext),
      )
    : await renderVariants(ctx, brief, references, ctx.request.variantCount, (index, ext) =>
        creativeKey(ctx.brand.id, ctx.jobId, index + 1, ext),
      );

  return variantKind ? variants.map((variant) => ({ ...variant, variantKind })) : variants;
}

/**
 * Loads the product's reference photos once so a regeneration conditions on
 * exactly what the first pass did. `variantKind` gates the brand's own logo/
 * style photos (FR-1.4 "website" material) — only the 'website' variant (or
 * uniform mode, where there is no kind to gate on) gets them; 'trend' and
 * 'clean' condition on the client's own product photos only.
 */
async function loadReferences(
  ctx: StageContext,
  variantKind?: VariantKind,
): Promise<ImageReference[]> {
  const rows = await ctx.db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, ctx.request.productId));

  const productReferences = await Promise.all(
    rows.map(async (row) => {
      // Prefer the background-removed variant when the asset-prep step has run
      // (FR-3.6): a cleaned cut-out conditions the model far better than a
      // photo with a busy background competing for attention.
      const key = row.cleanedStorageKey ?? row.storageKey;
      return {
        data: await ctx.storage.get(key),
        mediaType: mediaTypeFor(key),
        // Neutral wording on purpose: calling a destination photo a "product
        // photo" primes the model to hunt for a product that is not in it.
        label: row.isPrimary ? 'primary reference photograph' : 'reference photograph',
      };
    }),
  );

  const includeBrandReferences = !variantKind || variantKind === 'website';
  return [
    ...productReferences,
    ...(includeBrandReferences ? await loadBrandReferences(ctx) : []),
  ];
}

/**
 * The brand's own logo and photography, when the user has opted them in.
 *
 * Ordered after the product photos deliberately. The product is what the
 * advertisement is selling and has to stay the dominant reference; brand
 * assets are there to say how it should look, not what it should be. Labels do
 * the rest of that work — the image adapters pass them through to the model,
 * and a mislabelled style reference is precisely how a brand's hero shot ends
 * up reproduced as the subject.
 *
 * Every read is best-effort. A missing object is a degraded creative, never a
 * failed job: the storage key is stored at import time and the object could
 * have been pruned since, and that is not worth killing a paid generation for.
 */
async function loadBrandReferences(ctx: StageContext): Promise<ImageReference[]> {
  const references: ImageReference[] = [];

  const read = async (key: string, label: string) => {
    try {
      references.push({ data: await ctx.storage.get(key), mediaType: mediaTypeFor(key), label });
    } catch (error) {
      console.warn(`[content:image] job ${ctx.jobId}: could not load ${label} (${key}):`, error);
    }
  };

  if (ctx.logoStorageKey) {
    await read(ctx.logoStorageKey, "the brand's logo");
  }

  for (const key of ctx.styleReferenceKeys ?? []) {
    await read(key, 'style reference — visual treatment only, do not copy its contents');
  }

  return references;
}

/**
 * One provider call plus the storage writes it implies. Shared by the first
 * pass and by QA regeneration so both produce identically-shaped variants —
 * including thumbnails, which a regenerated variant would otherwise lack.
 */
async function renderVariants(
  ctx: StageContext,
  brief: Brief,
  references: ImageReference[],
  count: number,
  keyFor: (index: number, ext: 'jpg' | 'png') => string,
): Promise<GeneratedVariant[]> {
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
            count,
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
      const key = keyFor(index, image.mediaType === 'image/jpeg' ? 'jpg' : 'png');
      await ctx.storage.put(key, image.data, image.mediaType);

      return {
        storageKey: key,
        thumbnailStorageKey: await writeThumbnail(ctx, key, image.data),
        width: image.width,
        height: image.height,
        provider: generator.provider,
        model: image.model,
      };
    }),
  );
}

/**
 * Writes a small JPEG beside the full-size variant for the gallery grid.
 *
 * Always JPEG regardless of what the model returned: these are photographs, and
 * a PNG thumbnail of one is several times the size for no visible gain.
 *
 * Never fatal. A thumbnail is a loading optimisation, and failing the whole
 * generation over one would throw away images the customer has been charged
 * for. Callers fall back to the full-size asset when this returns null.
 */
/** Narrower than `StageContext` — only `storage`/`jobId` are used below — so
 *  a caller with no full stage context (asset-edit.ts) can reuse this without
 *  fabricating one. `StageContext` still satisfies it structurally. */
export async function writeThumbnail(
  ctx: Pick<StageContext, 'storage' | 'jobId'>,
  storageKey: string,
  data: Buffer,
): Promise<string | null> {
  try {
    const key = thumbnailKey(storageKey);
    const body = await sharp(data)
      // `inside` preserves the aspect ratio, so a story and a square both come
      // back correctly shaped; `withoutEnlargement` avoids upscaling a small one.
      .resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer();

    await ctx.storage.put(key, body, 'image/jpeg');
    return key;
  } catch (error) {
    console.warn(
      `[content:image] job ${ctx.jobId}: thumbnail failed for ${storageKey} — ${describeError(error)}`,
    );
    return null;
  }
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
 * When the readback disagrees, `regenerateFailures` gets one bounded chance to
 * do better (FR-3.5). TODO(content): FR-3.4 logo-overlay fallback with sharp.
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
              `Voice: ${toneDirection(brand.tone)}. ` +
              // FR-1.4. A tone dropdown gives five words; the brand's own site
              // shows how it actually writes, which is what makes generated
              // copy sound like them rather than like generic marketing. Same
              // fence as the brief: it governs how to write, never what about.
              (ctx.siteIdentity
                ? `How this brand writes, observed from their own website: ${ctx.siteIdentity.voiceSummary} ` +
                  `Their character: ${ctx.siteIdentity.brandPersonality} ` +
                  'Match that register, sentence rhythm and vocabulary. This tells you HOW to write, ' +
                  'not what to write about — the subject is the product named above, which may be ' +
                  "nothing like what their website discusses. " +
                  // Unlike the image brief, copy *may* use what the brand sells:
                  // a caption that echoes the brand's real promises reads as
                  // theirs, and words carry none of the hijack risk a rendered
                  // image does. Still bounded to claims the site actually makes.
                  (ctx.siteIdentity.messagingThemes.length
                    ? `Promises this brand actually makes on its site: ${ctx.siteIdentity.messagingThemes.join('; ')}. ` +
                      'Echo these where they genuinely apply to this product. Never restate one that does not — ' +
                      'a free-returns promise on a product it does not cover is a false claim. '
                    : '') +
                  (ctx.siteIdentity.offering
                    ? `For context, the business describes itself as: ${ctx.siteIdentity.offering} ` +
                      'Use this to judge register only. If the product above is not one of those things, ' +
                      'follow the product. '
                    : '')
                : '') +
              // Real catalogues are mixed; a saree shop may also sell gadgets.
              "If the product does not fit the shop's usual category, follow the " +
              'product and never describe it as something it is not. ' +
              'Write for real customers, not marketers. ' +
              'Be authentic, avoid hype. ' +
              'No fake claims, no emoji spam, no pricing you were not given.' +
              // Non-negotiable, so it sits in the system message rather than
              // the user turn where a long brief could bury it.
              (brand.bannedTopics.length
                ? ` Never mention or allude to: ${brand.bannedTopics.join(', ')} — under any framing, even in passing.`
                : ''),
            messages: [
              {
                role: 'user',
                content: [
                  `Create a ${platform} copy pack for a ${CAMPAIGN_INTENT[request.campaignType]} campaign.`,
                  '',
                  '**The product being advertised:**',
                  `${productLine}.`,
                  'This is the subject. The headline, the caption and every hashtag describe THIS item.',
                  product.sellingPoints.length
                    ? `Key selling points to draw on: ${product.sellingPoints.join(', ')}.`
                    : '',
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


/**
 * Stage 3b — one bounded second chance for variants whose text came back wrong.
 *
 * FR-3.5 asks for an automatic regeneration on QA failure. The reason it waited
 * for a decision is spend: retrying every variant would double the worst-case
 * cost of every job that trips QA. The ceiling that makes it safe:
 *
 *  - Only variants QA actually *checked* and *failed* are retried. A variant
 *    that could not be checked is not evidence of a bad image, and retrying it
 *    would spend money on a QA outage.
 *  - `rounds` is configuration (`QA_REGENERATION_ROUNDS`, default 1), not a
 *    literal, and 0 turns the whole stage off.
 *  - Worst case is therefore bounded at variantCount x (1 + rounds) images.
 *
 * "Best result" means a replacement is only taken when it actually passes. A
 * regeneration that fails too leaves the original in place — swapping one
 * failure for another would spend money to change nothing, and the first image
 * is at least the one the customer's brief produced.
 */
export async function regenerateFailures(
  ctx: StageContext,
  brief: Brief,
  checked: CheckedVariant[],
  rounds: number,
  variantKind?: VariantKind,
): Promise<CheckedVariant[]> {
  if (rounds < 1) return checked;

  // `checked` is the load-bearing half of this condition: `passed` is true for
  // an unverified variant, so filtering on `!passed` alone would be correct
  // today but would silently start retrying QA outages if that default flipped.
  const failedSlots = checked
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => variant.checked && !variant.passed);

  if (failedSlots.length === 0) return checked;

  const result = [...checked];
  const references = await loadReferences(ctx, variantKind);

  for (let round = 1; round <= rounds; round++) {
    const pending = failedSlots.filter(({ index }) => !result[index]!.passed);
    if (pending.length === 0) break;

    console.warn(
      `[content:qa] job ${ctx.jobId}: ${pending.length} variant(s) failed readback, regenerating (round ${round}/${rounds})`,
    );

    let replacements: CheckedVariant[];
    try {
      const rendered = await renderVariants(
        ctx,
        brief,
        references,
        pending.length,
        // Slot number keeps the retry beside the variant it replaces; the round
        // suffix stops it overwriting that variant, which is still the fallback.
        // In diverse mode `pending` only ever has one entry (each kind's own
        // mini-pipeline runs a length-1 batch), so `index` is always 0 — the
        // fixed per-kind slot is used instead, or the retry would collide with
        // whichever other kind also failed on the same round.
        (offset, ext) =>
          creativeKey(
            ctx.brand.id,
            ctx.jobId,
            variantKind ? VARIANT_SLOT_INDEX[variantKind] : pending[offset]!.index + 1,
            ext,
            round,
          ),
      );
      replacements = await qaImages(ctx, rendered, brief);
    } catch (error) {
      // A failed retry must not fail the job: the original variants are intact
      // and already paid for, so they ship rather than the customer getting
      // nothing.
      console.warn(
        `[content:qa] job ${ctx.jobId}: regeneration round ${round} failed, keeping originals — ${describeError(error)}`,
      );
      break;
    }

    pending.forEach(({ index }, offset) => {
      const candidate = replacements[offset];
      if (!candidate?.passed) return;
      result[index] = {
        ...candidate,
        notes: `regenerated after failed readback (round ${round})`,
      };
    });
  }

  return result;
}
