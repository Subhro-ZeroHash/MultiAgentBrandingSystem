import type { SiteColor, SiteColorRole, SiteExtraction, SiteFont } from '@bmas/shared';

/**
 * Pulls colours, typefaces, imagery and copy off a fetched page.
 *
 * Deliberately pattern-matching rather than a DOM parse. This is not walking a
 * document tree — it is reading a handful of well-formed, individually
 * recognisable things (meta tags, `link` hrefs, colour literals, `font-family`
 * declarations), and each extractor degrades to "found nothing" on malformed
 * input rather than throwing. That buys the feature with no new dependency,
 * which matters because a real parser is a build-time cost carried by two apps.
 *
 * Everything here is pure and synchronous so it can be tested against fixture
 * HTML without a network or a database.
 */

/** Below this, a page is a shell that paints itself in JavaScript. Reporting
 *  that honestly is far better than handing the analyser 40 words of nav links
 *  and letting it invent a brand from them. */
const MIN_MEANINGFUL_TEXT = 220;

const MAX_TEXT_EXCERPT = 12_000;
const MAX_HEADINGS = 24;

/** Never treated as a brand typeface: these name a fallback, not a choice. */
const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'roboto',
  'helvetica',
  'helvetica neue',
  'arial',
  'inherit',
  'initial',
  'unset',
  'revert',
  'currentcolor',
  'transparent',
]);

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function expandHex(hex: string): string | null {
  const value = hex.replace('#', '').toLowerCase();
  if (value.length === 3) {
    const [r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  // 8-digit hex carries alpha; the RGB half is what we want.
  if (value.length === 8) return `#${value.slice(0, 6)}`;
  if (value.length === 6) return `#${value}`;
  return null;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

/** hsl() is how Tailwind-era themes and most CSS-variable palettes express
 *  colour, so skipping it would miss the palette on a large class of sites. */
function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = ((h % 360) + 360) % 360;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));

  const rgb: [number, number, number] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];

  const match = lightness - chroma / 2;
  return rgbToHex((rgb[0] + match) * 255, (rgb[1] + match) * 255, (rgb[2] + match) * 255);
}

/** Any colour literal this extractor understands, normalised to 6-digit hex.
 *  Known gap: oklch() and lab() are not converted, so a Tailwind v4 or shadcn
 *  site — which express their palette that way — yields fewer colours than it
 *  should. Adding them is a colour-space conversion, not a new pattern. */
function normaliseColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();

  if (value.startsWith('#')) return expandHex(value);

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (rgb?.[1] && rgb[2] && rgb[3]) {
    return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }

  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
  if (hsl?.[1] && hsl[2] && hsl[3]) {
    return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  }

  return null;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l: l * 100 };

  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;

  return { h, s: s * 100, l: l * 100 };
}

/** A colour with no chroma, or so dark/light it can only be ink or paper.
 *  These are real and worth recording as background/text, but offering them as
 *  a brand accent produces a poster washed in off-white. */
function isNeutral(hex: string): boolean {
  const { s, l } = hexToHsl(hex);
  return s < 12 || l < 8 || l > 94;
}

/** Role hinted by the CSS property or custom-property name a colour is assigned
 *  to. A declared `--brand-primary` is worth far more than a colour counted off
 *  the page, so this is the strongest signal available without rendering. */
function roleFromName(name: string): { role: SiteColorRole; weight: number } | null {
  const key = name.toLowerCase();

  // Ordered: 'primary-background' should read as a background, not a primary.
  if (/(background|surface|canvas|\bbg\b|-bg\b|paper)/.test(key)) {
    return { role: 'background', weight: 40 };
  }
  if (/(foreground|\bfg\b|-fg\b|\btext\b|-text\b|body-color|ink)/.test(key)) {
    return { role: 'text', weight: 40 };
  }
  if (/(primary|brand|main)/.test(key)) return { role: 'primary', weight: 120 };
  if (/(secondary)/.test(key)) return { role: 'secondary', weight: 100 };
  if (/(accent|highlight|cta|link|button|btn)/.test(key)) {
    return { role: 'accent', weight: 90 };
  }
  return null;
}

/** Role implied by an ordinary declaration, when no name gives a better clue. */
function roleFromProperty(property: string): { role: SiteColorRole; weight: number } {
  const key = property.toLowerCase();
  if (key.includes('background')) return { role: 'background', weight: 2 };
  if (key === 'color') return { role: 'text', weight: 2 };
  if (key.includes('border') || key === 'fill' || key === 'stroke') {
    return { role: 'accent', weight: 3 };
  }
  return { role: 'accent', weight: 1 };
}

const ROLE_PRIORITY: Record<SiteColorRole, number> = {
  primary: 5,
  secondary: 4,
  accent: 3,
  background: 2,
  text: 1,
};

/**
 * Ranks the page's colours.
 *
 * Two passes with very different authority: a custom property whose name says
 * "primary" is taken at its word, while a colour merely used a lot is weighted
 * by how often. Aggregated by hex, so the same colour declared as a variable
 * and used in fifty rules ends up one entry.
 */
export function extractColors(html: string, stylesheets: readonly string[]): SiteColor[] {
  const css = [...inlineStyleBlocks(html), ...stylesheets].join('\n');
  const totals = new Map<string, { weight: number; role: SiteColorRole }>();

  const add = (hex: string, role: SiteColorRole, weight: number) => {
    const existing = totals.get(hex);
    if (!existing) {
      totals.set(hex, { weight, role });
      return;
    }
    existing.weight += weight;
    // Keep the most specific role anything claimed for this colour.
    if (ROLE_PRIORITY[role] > ROLE_PRIORITY[existing.role]) existing.role = role;
  };

  // Pass 1 — custom properties. `--brand-primary: #7c2d12`
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!name || !value) continue;
    const hex = normaliseColor(value);
    if (!hex) continue;

    const hint = roleFromName(name);
    if (hint) add(hex, hint.role, hint.weight);
    else add(hex, isNeutral(hex) ? 'background' : 'accent', 20);
  }

  // Pass 2 — ordinary declarations. `background-color: rgb(124 45 18)`
  const declaration = /([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g;
  for (const [, property, value] of css.matchAll(declaration)) {
    if (!property || !value) continue;
    if (property.startsWith('--')) continue; // already counted, at higher weight

    const hex = normaliseColor(value);
    if (!hex) continue;

    const hint = roleFromProperty(property);
    add(hex, hint.role, hint.weight);
  }

  // `<meta name="theme-color">` is a deliberate statement of the brand colour
  // by whoever built the site, so it outranks anything counted off a stylesheet.
  const themeColor = metaContent(html, 'theme-color');
  if (themeColor) {
    const hex = normaliseColor(themeColor);
    if (hex) add(hex, 'primary', 150);
  }

  return (
    [...totals.entries()]
      .map(([hex, { weight, role }]) => ({ hex, weight, role }))
      // Chromatic colours first, then by weight: a brand's palette is what the
      // brief wants, and neutrals would otherwise take every slot.
      .sort((a, b) => {
        const neutrality = Number(isNeutral(a.hex)) - Number(isNeutral(b.hex));
        return neutrality !== 0 ? neutrality : b.weight - a.weight;
      })
      .slice(0, 12)
  );
}

/** The chromatic colours, in rank order — what actually reaches the Brand Kit's
 *  three-colour palette. */
export function brandPalette(colors: readonly SiteColor[], limit = 3): string[] {
  return colors
    .filter((color) => !isNeutral(color.hex))
    .slice(0, limit)
    .map((color) => color.hex);
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Icon fonts. Every one of these is a glyph set, not a typeface anyone chose
 * to set words in, and they are declared through exactly the same `@font-face`
 * and `font-family` rules as real type. Left in, a Bootstrap site reports its
 * brand typography as "Font Awesome 5 Free" — which then reaches the analyser
 * as the brand's letterforms.
 */
const ICON_FAMILIES =
  /icon|font ?awesome|material symbols|glyphicons|typicons|dashicons|themify|linearicons|feather|icomoon|elusive/i;

function cleanFamily(raw: string): string | null {
  const family = raw
    // Before the quotes are stripped, or the closing quote is no longer at the
    // end and survives into the name. Observed live: a family reported as
    // `JudgemeStar' !important`, which then failed to merge with `JudgemeStar`.
    .replace(/!\s*important/gi, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!family) return null;
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return null;
  // var(--font-x) references and other functions are not a family name.
  if (family.includes('(') || family.startsWith('--')) return null;
  if (family.length > 60) return null;
  // A number, with or without a unit, is a weight or a size that reached here
  // from a `--font-*` custom property. Observed live: `300` and `6lvh` were
  // both reported as typefaces. The unit set is left open rather than
  // enumerated — CSS keeps adding them (lvh, dvh, cqw), and no real family
  // name begins with a digit and runs to four characters.
  if (/^[\d.]+[a-z%]{0,4}$/i.test(family)) return null;
  if (ICON_FAMILIES.test(family)) return null;
  return family;
}

/** "Open Sans" and "OpenSans" are one typeface declared two ways, and a site
 *  that does both should not spend two of its four slots saying so. */
function familyKey(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Typefaces the site uses, most prominent first.
 *
 * A Google Fonts `<link>` is the clearest signal available — a site that loads
 * a font has chosen it — and its first family is conventionally the display
 * face. Beyond that, declarations are counted, and the heading/body split falls
 * out of variable names where they exist and frequency where they do not.
 */
export function extractFonts(html: string, stylesheets: readonly string[]): SiteFont[] {
  const css = [...inlineStyleBlocks(html), ...stylesheets].join('\n');
  const counts = new Map<string, number>();
  const roles = new Map<string, 'heading' | 'body'>();

  // Keyed by the normalised name so the two spellings of one family merge,
  // while the display name keeps whichever spelling reads better.
  const display = new Map<string, string>();

  const add = (raw: string, weight: number, role?: 'heading' | 'body') => {
    const family = cleanFamily(raw);
    if (!family) return;

    const key = familyKey(family);
    if (!key) return;

    counts.set(key, (counts.get(key) ?? 0) + weight);
    // Prefer the spaced spelling: "Open Sans" over "OpenSans".
    const seen = display.get(key);
    if (!seen || (!seen.includes(' ') && family.includes(' '))) display.set(key, family);
    if (role && !roles.has(key)) roles.set(key, role);
  };

  // Loaded webfonts, from the stylesheet URL rather than the CSS body.
  for (const [, href] of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (!href || !/fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit/.test(href)) continue;
    for (const [, family] of href.matchAll(/family=([^&:;]+)/g)) {
      if (family) add(decodeURIComponent(family.replace(/\+/g, ' ')), 60);
    }
  }

  // @font-face declares a self-hosted face, which is equally deliberate.
  for (const [, family] of css.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*([^;}]+)/gi)) {
    if (family) add(family, 50);
  }

  // Named variables carry the role the site itself assigned.
  for (const [, name, value] of css.matchAll(/(--[\w-]*font[\w-]*)\s*:\s*([^;{}]+)/gi)) {
    if (!name || !value) continue;
    // `--font-*` also names weights, sizes and line heights. Those are not
    // families, and their values are bare numbers — skipping them by name is
    // cheaper and clearer than filtering the numbers out downstream.
    if (/(weight|size|height|spacing|style|variant|stretch|feature)/i.test(name)) continue;

    const role = /(heading|display|title|serif-display)/i.test(name)
      ? ('heading' as const)
      : /(body|sans|base|text)/i.test(name)
        ? ('body' as const)
        : undefined;
    add(value.split(',')[0] ?? '', 40, role);
  }

  for (const [, value] of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    if (value) add(value.split(',')[0] ?? '', 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  return ranked.map(([key], index) => ({
    family: display.get(key) ?? key,
    // Where the site did not say, the most-used face is the body text and the
    // next distinct one is the display face — which is the usual arrangement.
    role: roles.get(key) ?? (index === 0 ? 'body' : 'heading'),
  }));
}

/**
 * Numeric font weights the stylesheets declare.
 *
 * Keyword weights are folded into their numeric equivalents so `bold` and
 * `700` do not read as two different choices. Only weights a brand actually
 * loads are meaningful: a site that ships 300 and 400 is making a quiet,
 * light-typography choice, and one that ships 800 is not.
 */
export function extractFontWeights(html: string, stylesheets: readonly string[]): number[] {
  const css = [...inlineStyleBlocks(html), ...stylesheets].join('\n');
  const weights = new Set<number>();

  const KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };

  for (const [, value] of css.matchAll(/font-weight\s*:\s*([^;}]+)/gi)) {
    const raw = value?.trim().toLowerCase() ?? '';
    const keyword = KEYWORDS[raw];
    if (keyword) {
      weights.add(keyword);
      continue;
    }
    const numeric = /^(\d{2,4})$/.exec(raw);
    if (numeric?.[1]) {
      const weight = Number(numeric[1]);
      if (weight >= 1 && weight <= 1000) weights.add(weight);
    }
  }

  // Google Fonts encodes the loaded weights in the URL (`wght@400;700`), which
  // is more reliable than counting declarations: it is what the brand paid to
  // download, rather than every value any rule happens to set.
  for (const [, href] of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (!href || !/fonts\.googleapis\.com|fonts\.bunny\.net/.test(href)) continue;
    for (const [, spec] of href.matchAll(/wght@([\d;.,]+)/g)) {
      for (const part of (spec ?? '').split(/[;,]/)) {
        const weight = Number(part);
        if (Number.isInteger(weight) && weight >= 1 && weight <= 1000) weights.add(weight);
      }
    }
  }

  return [...weights].sort((a, b) => a - b).slice(0, 12);
}

/**
 * Whether headings are set in caps.
 *
 * Judged on the rendered text rather than on `text-transform`, because the
 * transform may live in a class this extractor cannot resolve to an element.
 * Single-word headings are ignored — "SHOP" proves nothing, and nav labels are
 * frequently capitalised while the brand's actual headings are not.
 */
export function extractHeadingCasing(
  headings: readonly string[],
): 'uppercase' | 'lowercase' | 'mixed' | null {
  const considered = headings.filter((heading) => heading.split(/\s+/).length > 1);
  if (considered.length < 2) return null;

  const cased = considered.filter((heading) => /[a-z]/i.test(heading));
  if (cased.length === 0) return null;

  const upper = cased.filter((heading) => heading === heading.toUpperCase()).length;
  const lower = cased.filter((heading) => heading === heading.toLowerCase()).length;

  if (upper / cased.length >= 0.6) return 'uppercase';
  if (lower / cased.length >= 0.6) return 'lowercase';
  return 'mixed';
}

/**
 * Lines that read as a brand promise rather than navigation.
 *
 * Heuristic and deliberately conservative: a tagline is a short phrase of
 * several words with no trailing punctuation of a sentence, and nav labels
 * ("Shop All", "Contact") are too short to qualify. Wrong guesses are cheap
 * here — these are offered to the analyser as candidates, not used directly.
 */
export function extractTaglines(html: string, headings: readonly string[]): string[] {
  const candidates: string[] = [];

  const ogTitle = metaContent(html, 'og:title');
  const description = metaContent(html, 'description');
  for (const value of [ogTitle, description]) {
    if (value && value.split(/\s+/).length >= 3) candidates.push(value);
  }

  for (const heading of headings) {
    const words = heading.split(/\s+/).length;
    if (words >= 3 && words <= 14 && heading.length <= 140) candidates.push(heading);
  }

  const seen = new Set<string>();
  return candidates
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

/** Images large or prominent enough to read as brand photography, most
 *  prominent first. `og:image` leads because it is the one image the brand
 *  deliberately chose to represent the page. */
export function extractImageUrls(html: string, baseUrl: string, logoUrl: string | null): string[] {
  const found: string[] = [];

  const push = (value: string | null | undefined) => {
    if (!value || value.startsWith('data:')) return;
    try {
      const resolved = new URL(value, baseUrl);
      if (!/^https?:$/.test(resolved.protocol)) return;
      const url = resolved.toString();
      // The logo is handled separately and is not photography.
      if (url === logoUrl) return;
      // Sprites, icons and tracking pixels are not brand imagery.
      if (/sprite|icon|favicon|pixel|badge|\.svg($|\?)/i.test(url)) return;
      if (!found.includes(url)) found.push(url);
    } catch {
      // Unusable reference; skip it.
    }
  };

  push(metaContent(html, 'og:image'));
  push(metaContent(html, 'twitter:image'));

  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (/logo|wordmark/i.test(tag)) continue;

    // A srcset's last entry is the largest rendition, which is the one worth
    // conditioning on; fall back to src for sites that do not ship one.
    const srcset = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (srcset) {
      const largest = srcset.split(',').pop()?.trim().split(/\s+/)[0];
      push(largest);
      continue;
    }
    push(
      /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ??
        /\bdata-src\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1],
    );
  }

  return found.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Text and imagery
// ---------------------------------------------------------------------------

function inlineStyleBlocks(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(([, body]) => body ?? '')
    .filter(Boolean);
}

/** Reads `<meta name="x" content="...">` and the `property=` (OpenGraph) form,
 *  in either attribute order. */
export function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["']`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || null;
  }
  return null;
}

/** The handful of entities that actually show up in page copy. A full table is
 *  not worth carrying; anything missed is one odd character in a prompt. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Strips markup and the elements whose contents are not prose. Script and
 *  style bodies must go first — a minified bundle is mostly punctuation and
 *  would swamp the excerpt with noise the analyser then tries to read. */
export function visibleText(html: string): string {
  return (
    decodeEntities(
      html
        .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\b[^>]*>/gi, '\n')
        .replace(/<\/(p|div|section|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    )
      // The class holds a non-breaking space, written as an escape rather than the
      // literal character: a decoded &nbsp; is invisible in source and trips
      // no-irregular-whitespace, but it is exactly what needs collapsing here.
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim()
  );
}

export function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  for (const [, , inner] of html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = visibleText(inner ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && text.length <= 300 && !headings.includes(text)) headings.push(text);
    if (headings.length >= MAX_HEADINGS) break;
  }
  return headings;
}

/**
 * Best guess at the brand's logo.
 *
 * Ordered by how deliberate each source is: `og:image` is chosen for sharing,
 * an apple-touch-icon is chosen for a home screen, and a favicon is at least
 * chosen. An `<img>` with "logo" in its attributes is the fallback, and the
 * least reliable — plenty of sites label a partner badge that way.
 */
export function extractLogoUrl(html: string, baseUrl: string): string | null {
  const candidates: Array<string | null> = [
    metaContent(html, 'og:logo'),
    metaContent(html, 'og:image'),
    linkHref(html, 'apple-touch-icon'),
    linkHref(html, 'icon'),
    logoImage(html),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const resolved = new URL(candidate, baseUrl);
      if (/^https?:$/.test(resolved.protocol)) return resolved.toString();
    } catch {
      // Not a usable reference; try the next candidate.
    }
  }
  return null;
}

function linkHref(html: string, rel: string): string | null {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const relValue = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!relValue) continue;
    if (!relValue.toLowerCase().split(/\s+/).includes(rel)) continue;

    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (href) return href;
  }
  return null;
}

function logoImage(html: string): string | null {
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/logo|brand|wordmark/i.test(tag)) continue;
    const src =
      /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ??
      /\bdata-src\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    // Inline data URIs are usually a tracking pixel or a lazy-load placeholder.
    if (src && !src.startsWith('data:')) return src;
  }
  return null;
}

// ---------------------------------------------------------------------------

export interface ExtractSiteInput {
  html: string;
  stylesheets: readonly string[];
  finalUrl: string;
}

/** Runs every extractor and reports whether the page carried enough to read. */
export function extractSite(input: ExtractSiteInput): {
  extraction: SiteExtraction;
  looksEmpty: boolean;
} {
  const { html, stylesheets, finalUrl } = input;

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const headings = extractHeadings(html);
  const text = visibleText(html);

  const logoUrl = extractLogoUrl(html, finalUrl);

  const extraction: SiteExtraction = {
    title: title ? decodeEntities(title).replace(/\s+/g, ' ').trim() || null : null,
    description:
      metaContent(html, 'description') ??
      metaContent(html, 'og:description') ??
      metaContent(html, 'twitter:description'),
    headings,
    colors: extractColors(html, stylesheets),
    fonts: extractFonts(html, stylesheets),
    fontWeights: extractFontWeights(html, stylesheets),
    headingCasing: extractHeadingCasing(headings),
    logoUrl,
    taglines: extractTaglines(html, headings),
    imageUrls: extractImageUrls(html, finalUrl, logoUrl),
    textExcerpt: text.slice(0, MAX_TEXT_EXCERPT),
  };

  // Headings are the tell: a shell has a <title> and nav links but no content
  // headings, because those are rendered client-side.
  const looksEmpty = text.length < MIN_MEANINGFUL_TEXT && headings.length === 0;

  return { extraction, looksEmpty };
}
