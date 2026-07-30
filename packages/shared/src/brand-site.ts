import { z } from 'zod';
import { hexColorSchema, toneOfVoiceSchema } from './brand.js';
import { entityIdSchema } from './common.js';

/**
 * Website-derived brand identity (FR-1.4).
 *
 * The brand's own site is the best available statement of how it already
 * presents itself, so reading it once at setup gives generation far more to go
 * on than a tone dropdown. What comes back is a *proposal*: extraction is
 * fallible and `brands.colors` is treated as authoritative by the brief, so a
 * wrong guess would silently colour every future creative. The user confirms
 * before anything is written to the Brand Kit.
 */

/**
 * What a colour is doing on the page. Rank matters more than precision here:
 * the brief wants two or three accent colours, not a full design system, and a
 * background misread as an accent produces a poster washed in off-white.
 */
export const siteColorRoleSchema = z.enum([
  'primary',
  'secondary',
  'accent',
  'background',
  'text',
]);
export type SiteColorRole = z.infer<typeof siteColorRoleSchema>;

export const siteColorSchema = z.object({
  hex: hexColorSchema,
  role: siteColorRoleSchema,
  /** How much of the stylesheet used it — the ranking signal, not a percentage. */
  weight: z.number().nonnegative(),
});
export type SiteColor = z.infer<typeof siteColorSchema>;

/**
 * A typeface the site declares.
 *
 * Stored as the raw family name because that is all the page gives us. An
 * image model cannot load a font file, and naming "Poppins" at it achieves
 * nothing on its own — so these names are input to the analyser, which turns
 * them into the described letterform ("a geometric sans-serif, medium weight")
 * that does steer rendered type. The names themselves are kept for the review
 * screen, where the user needs to see what we actually found.
 */
export const siteFontSchema = z.object({
  family: z.string().min(1).max(120),
  role: z.enum(['heading', 'body']),
});
export type SiteFont = z.infer<typeof siteFontSchema>;

/** How the fetch went. Kept on the row so the UI can explain a thin result
 *  rather than showing an empty palette with no reason for it. */
export const siteProfileStatusSchema = z.enum([
  'ok',
  /** Fetched, but the body was effectively empty — almost always a
   *  client-rendered SPA that ships a shell and paints in JavaScript. */
  'empty_document',
  'unreachable',
  'failed',
]);
export type SiteProfileStatus = z.infer<typeof siteProfileStatusSchema>;

/**
 * What the deterministic pass pulls off the page, before any model sees it.
 * Separated from the analysis so a re-analysis (a better prompt, a different
 * model) never needs a second fetch of someone else's server.
 */
export const siteExtractionSchema = z.object({
  title: z.string().max(300).nullable(),
  description: z.string().max(1000).nullable(),
  headings: z.array(z.string().max(300)).max(30),
  colors: z.array(siteColorSchema).max(12),
  fonts: z.array(siteFontSchema).max(6),
  /** Numeric weights the stylesheets declare, e.g. [300, 400, 700]. A brand
   *  that only ever sets 300 reads very differently from one that only sets
   *  800, and that difference survives into a rendered poster. */
  fontWeights: z.array(z.number().int().min(1).max(1000)).max(12),
  /** Whether headings are set in caps. Cheap to detect and unusually
   *  informative — all-caps headings are a deliberate, very visible choice. */
  headingCasing: z.enum(['uppercase', 'lowercase', 'mixed']).nullable(),
  logoUrl: z.string().url().nullable(),
  /** Short declarative lines that read as taglines rather than nav labels. */
  taglines: z.array(z.string().max(200)).max(10),
  /** Candidate brand photography, most prominent first. Used as visual style
   *  reference for the image model — see `styleReferenceKeys` on the profile. */
  imageUrls: z.array(z.string().url()).max(8),
  /** Visible copy, collapsed and truncated. The analyser's only real input. */
  textExcerpt: z.string().max(20_000),
});
export type SiteExtraction = z.infer<typeof siteExtractionSchema>;

/**
 * The model's reading of the extraction.
 *
 * `visualIdentity` and `voiceSummary` are written to be dropped straight into
 * the image brief and the copy system prompt respectively, which is why they
 * are prose rather than structured fields — both prompts are prose, and a
 * keyword list reads to an image model as a tag soup.
 */
export const siteAnalysisSchema = z.object({
  /** The synthesis — overall art direction in one paragraph. The granular
   *  fields below are what the brief actually leans on; this carries the
   *  gestalt they cannot, and is what a human reads on the review screen. */
  visualIdentity: z.string().min(1).max(2000),
  /** How the palette is *deployed*: which colour dominates, which is reserved
   *  for emphasis, what sits behind the type. Hex codes alone say nothing about
   *  proportion, and proportion is most of what makes a palette recognisable. */
  colorUsage: z.string().min(1).max(1200),
  /** Letterforms described rather than named, plus weight and casing habits —
   *  an image model cannot install a font but does render a description. */
  typography: z.string().min(1).max(1200),
  /** Photographic treatment: lighting, depth, staging, colour grade, how much
   *  air the compositions carry. */
  imageryStyle: z.string().min(1).max(1200),
  /** Character rather than register — what the brand is like, as a person. */
  brandPersonality: z.string().min(1).max(1200),
  /** How the brand writes: register, sentence length, vocabulary, habits. */
  voiceSummary: z.string().min(1).max(1500),
  /** Recurring promises and value propositions, verbatim where possible.
   *  Copy leans on these so a caption echoes what the brand actually claims. */
  messagingThemes: z.array(z.string().max(300)).max(10),
  /**
   * What the business sells, in a sentence.
   *
   * Deliberately kept out of the image brief's subject line. It is genuinely
   * useful for copy and for populating the Brand Kit's category, but a poster
   * advertises the product in *this* request, which is frequently not what the
   * homepage is about — feeding it to the image model is precisely how a
   * travel package ends up rendered as boutique merchandise.
   */
  offering: z.string().max(600).nullable(),
  suggestedName: z.string().max(120).nullable(),
  suggestedCategory: z.string().max(120).nullable(),
  suggestedAudience: z.string().max(500).nullable(),
  suggestedTone: z.array(toneOfVoiceSchema).max(3),
  suggestedLanguages: z.array(z.string().min(1).max(40)).max(10),
});
export type SiteAnalysis = z.infer<typeof siteAnalysisSchema>;

export const brandSiteProfileSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  sourceUrl: z.string().url(),
  status: siteProfileStatusSchema,
  extraction: siteExtractionSchema.nullable(),
  analysis: siteAnalysisSchema.nullable(),
  /** The brand's logo, copied into our own object storage at import time.
   *  Stored rather than linked because the image stage needs the bytes, and a
   *  hotlink to someone's CDN breaks the day they redesign. */
  logoStorageKey: z.string().nullable(),
  /** Brand photography kept as visual style reference for the image model.
   *  Storage keys, same reasoning as the logo. */
  styleReferenceKeys: z.array(z.string()).max(4),
  error: z.string().nullable(),
  fetchedAt: z.coerce.date(),
  /** Set when the user accepts the proposal. An unapplied profile is inert:
   *  the pipeline reads only applied ones, so a rejected import cannot leak
   *  into generation. */
  appliedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BrandSiteProfile = z.infer<typeof brandSiteProfileSchema>;

/**
 * Only http(s) is accepted, and it is checked here as well as at fetch time.
 * A `file:`, `gopher:` or `data:` URL reaching a server-side fetch is the
 * classic SSRF opener, and rejecting it in the shared schema means every
 * caller gets the same answer.
 */
export const importBrandSiteSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), {
      message: 'Only http and https URLs can be imported',
    }),
});
export type ImportBrandSiteInput = z.infer<typeof importBrandSiteSchema>;

/**
 * Which parts of the proposal to write into the Brand Kit.
 *
 * Field-by-field rather than all-or-nothing: the palette is usually right and
 * the audience blurb usually needs a human edit, and a user who has already
 * written a good audience line should not have to choose between keeping it
 * and taking the colours.
 */
export const applyBrandSiteSchema = z.object({
  colors: z.array(hexColorSchema).max(3).optional(),
  tone: z.array(toneOfVoiceSchema).min(1).max(3).optional(),
  category: z.string().max(120).nullable().optional(),
  audience: z.string().max(500).nullable().optional(),
  languages: z.array(z.string().min(1).max(40)).max(10).optional(),
  logoUrl: z.string().url().nullable().optional(),
  /** Whether the prose direction feeds generation. Defaults on — it is the
   *  point of the feature — but it is separable from the Brand Kit fields. */
  useForGeneration: z.boolean().default(true),
  /**
   * Whether the scraped logo is composited onto generated creatives.
   *
   * Separate from `useForGeneration` because the failure modes differ in kind:
   * a wrong art direction makes a poster look off-brand, while a wrong logo —
   * a partner badge, a payment-provider mark, a stock icon — puts someone
   * else's trademark on the brand's advertising. Off by default for that
   * reason; the review screen shows the image before this can be set.
   */
  useLogo: z.boolean().default(false),
  /**
   * Whether the brand's own photography conditions the image model.
   *
   * The strongest lever for "looks like their brand" and the easiest to
   * misuse: photographs carry subject matter, and a hero shot passed as
   * reference invites the model to reproduce what is *in* it. The brief labels
   * these as style-only, but the guard is imperfect, so this is opt-in.
   */
  useStyleReferences: z.boolean().default(false),
});
export type ApplyBrandSiteInput = z.infer<typeof applyBrandSiteSchema>;
