import { withRetry, withTimeout, type AiRegistry } from '@bmas/ai';
import {
  siteAnalysisSchema,
  type CostEvent,
  type SiteAnalysis,
  type SiteExtraction,
} from '@bmas/shared';

/**
 * Turns a raw extraction into direction the pipeline can use.
 *
 * Runs on `orchestrator`: this is read once per brand and every creative that
 * brand ever generates inherits the result, so it is the wrong place to save a
 * fraction of a cent. Contrast the copy stage, which fans out per platform on
 * `volume` and is cheap to retry.
 *
 * The output is prose because both consumers are prose. `visualIdentity` is
 * dropped into the image brief and `voiceSummary` into the copy system prompt,
 * and a keyword list in either position reads as tag soup to the model.
 */

/** Caps what the model is asked to read. A homepage's worth of copy is plenty
 *  to characterise a brand, and the rest is footer, cookie notice and nav. */
const MAX_ANALYSIS_CHARS = 6000;

/**
 * Headroom for six prose fields plus the structured tail.
 *
 * Not arbitrary, and raised twice for the same reason: constrained decoding cut
 * short by the token ceiling produces *valid-looking* JSON that fails to parse,
 * so the symptom points at the model rather than at this number. 2000 truncated
 * when there were two prose fields; this analysis has six plus a string array,
 * so the ceiling scales with them rather than staying where it was.
 */
const MAX_ANALYSIS_TOKENS = 8192;

/** One analysis should not outlast the user's patience on an onboarding
 *  screen; the fetch ahead of it has already spent part of the budget. */
const ANALYSIS_TIMEOUT_MS = 45_000;

const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'visualIdentity',
    'colorUsage',
    'typography',
    'imageryStyle',
    'brandPersonality',
    'voiceSummary',
    'messagingThemes',
    'offering',
    'suggestedName',
    'suggestedCategory',
    'suggestedAudience',
    'suggestedTone',
    'suggestedLanguages',
  ],
  properties: {
    visualIdentity: {
      type: 'string',
      description:
        'The overall look in 2-4 sentences — the gestalt the granular fields below cannot carry. ' +
        'Styling only, never subject matter.',
    },
    colorUsage: {
      type: 'string',
      description:
        'How the palette is deployed, 2-3 sentences: which colour dominates and over how much area, ' +
        'which is reserved for emphasis or calls to action, what sits behind body text, whether the ' +
        'overall effect is high or low contrast. Name the hex codes you are describing.',
    },
    typography: {
      type: 'string',
      description:
        'Letterforms DESCRIBED, not named, 2-3 sentences: serif or sans, geometric or humanist, ' +
        'aperture, stroke contrast, the weights actually in use, whether headings are set in caps, ' +
        'how tight the letter-spacing reads, headline-to-body size relationship.',
    },
    imageryStyle: {
      type: 'string',
      description:
        'Photographic treatment, 2-3 sentences: lighting direction and hardness, depth of field, ' +
        'studio or in-situ, colour grade, how much negative space, styled or candid. Describe the ' +
        'TREATMENT, never the objects photographed.',
    },
    brandPersonality: {
      type: 'string',
      description:
        'The brand as a character, 2-3 sentences: confident or gentle, expert or companionable, ' +
        'serious or irreverent, traditional or contemporary, and who it is trying to be for people.',
    },
    voiceSummary: {
      type: 'string',
      description:
        'How this brand writes, 2-4 sentences: register, sentence length, vocabulary, recurring ' +
        'habits, what it avoids.',
    },
    messagingThemes: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
      description:
        'Recurring promises and value propositions, phrased as the brand phrases them — ' +
        '"handwoven by artisans", "free returns for 30 days". Claims the brand actually makes, ' +
        'never ones you infer.',
    },
    offering: {
      type: ['string', 'null'],
      description:
        'What this business sells, in one sentence. Used to understand the brand, NOT to decide ' +
        'what any advertisement depicts.',
    },
    suggestedName: { type: ['string', 'null'] },
    suggestedCategory: { type: ['string', 'null'] },
    suggestedAudience: { type: ['string', 'null'] },
    suggestedTone: {
      type: 'array',
      items: { enum: ['friendly', 'premium', 'playful', 'traditional', 'elegant'] },
      maxItems: 3,
    },
    suggestedLanguages: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  },
} as const;

function describeColors(extraction: SiteExtraction): string {
  if (extraction.colors.length === 0) return 'No colours could be read from the stylesheets.';
  return extraction.colors
    .slice(0, 8)
    .map((color) => `${color.hex} (used as ${color.role})`)
    .join(', ');
}

function describeFonts(extraction: SiteExtraction): string {
  if (extraction.fonts.length === 0) return 'No typefaces could be read from the stylesheets.';

  const families = extraction.fonts.map((font) => `${font.family} (${font.role})`).join(', ');
  const weights = extraction.fontWeights.length
    ? ` Weights loaded: ${extraction.fontWeights.join(', ')}.`
    : '';
  const casing = extraction.headingCasing
    ? ` Headings are predominantly ${extraction.headingCasing}.`
    : '';

  return `${families}.${weights}${casing}`;
}

export interface AnalyzeSiteResult {
  analysis: SiteAnalysis;
  cost: CostEvent;
}

export async function analyzeSite(
  ai: AiRegistry,
  extraction: SiteExtraction,
  sourceUrl: string,
  ctx?: { brandId?: string; referenceId?: string },
): Promise<AnalyzeSiteResult> {
  // Wrapped like every other provider call in the codebase: the adapter marks
  // a truncated or malformed JSON response retryable precisely because a rerun
  // usually fits, and without a retry here that surfaced to the user as a hard
  // "could not read your website" for a transient formatting failure.
  const { value, cost } = await withRetry(
    () =>
      withTimeout(
        ai.llm().generateJson<SiteAnalysis>(
          {
            role: 'orchestrator',
            system:
              'You are a brand strategist reading a company website in order to brief a designer and a copywriter ' +
              'who have never seen it. You describe what is actually there. You do not flatter, aspirationalise, ' +
              'or invent detail the page does not support.\n\n' +
              // The single most important constraint. The brief this feeds is
              // carefully fenced so brand context cannot hijack the subject of the
              // ad — a travel package once rendered as a saree because the brand row
              // said "saree boutique". Website content is that same hazard, larger.
              'CRITICAL — this governs five of the fields you are about to write. `visualIdentity`, ' +
              '`colorUsage`, `typography`, `imageryStyle` and `brandPersonality` describe how things should ' +
              'LOOK and FEEL. None of them may describe WHAT to depict. The products, services and imagery ' +
              'on this website are not the subject of the advertisements they will be used for; each ad has ' +
              "its own product, often unrelated to anything on this page. Naming the site's merchandise, " +
              'industry or scenery in those five fields would cause every future advertisement to depict the ' +
              'wrong thing.\n\n' +
              'Write them as direction to a photographer and art director: "Warm terracotta and gold against ' +
              'off-white, generous margins, a high-contrast serif for headlines set large, soft directional ' +
              'daylight, unhurried and premium." Never: "Show sarees in a boutique setting."\n\n' +
              // The escape valve. Without somewhere legitimate to put what the
              // brand sells, the model smuggles it into the styling fields.
              '`offering` and `messagingThemes` are where what-the-brand-sells belongs, and they are read by ' +
              'the copywriter rather than the designer. Put it there and keep it out of the other five.',
            messages: [
              {
                role: 'user',
                content: [
                  `Website: ${sourceUrl}`,
                  extraction.title ? `Page title: ${extraction.title}` : '',
                  extraction.description ? `Meta description: ${extraction.description}` : '',
                  '',
                  `Colours found in the stylesheets: ${describeColors(extraction)}`,
                  `Typefaces found: ${describeFonts(extraction)}`,
                  '',
                  extraction.headings.length
                    ? `Headings on the page:\n${extraction.headings.map((h) => `- ${h}`).join('\n')}`
                    : '',
                  extraction.taglines.length
                    ? `Lines that read as brand promises:\n${extraction.taglines.map((t) => `- ${t}`).join('\n')}`
                    : '',
                  '',
                  'Visible copy from the page:',
                  '"""',
                  extraction.textExcerpt.slice(0, MAX_ANALYSIS_CHARS),
                  '"""',
                  '',
                  'Produce the analysis. For `typography`, translate the typeface names above into described ' +
                    'letterforms — a designer briefing another designer would say "a geometric sans-serif with wide ' +
                    'apertures, set medium" rather than naming the font, because the person rendering it cannot ' +
                    'install fonts and only understands the description.',
                  'For `colorUsage`, reason from the roles above: a colour recorded as `background` covers most ' +
                    'of the page, one recorded as `accent` is used sparingly for emphasis. Proportion is what ' +
                    'makes a palette recognisable, and the hex codes alone do not carry it.',
                  'For `suggestedTone`, choose only from: friendly, premium, playful, traditional, elegant. ' +
                    'Pick the one or two that genuinely fit; do not pick all of them.',
                  'For `suggestedLanguages`, list only languages the page is actually written in.',
                  'Use null for any suggested field the page does not support. A confident wrong guess is worse ' +
                    'than an admission that it is not there.',
                  'Respect the sentence counts in the field descriptions. Every prose field is pasted into a ' +
                    'longer brief, and a page of prose in any of them drowns the instructions around it.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            maxTokens: MAX_ANALYSIS_TOKENS,
            schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
            parse: (raw) => siteAnalysisSchema.parse(raw),
          },
          ctx,
        ),
        ANALYSIS_TIMEOUT_MS,
        'site analysis',
      ),
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[brand-site] analysis attempt ${attempt} failed, retrying:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );

  return { analysis: value, cost };
}
