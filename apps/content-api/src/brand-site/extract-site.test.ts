import { describe, expect, it } from 'vitest';
import {
  brandPalette,
  extractColors,
  extractFontWeights,
  extractFonts,
  extractHeadingCasing,
  extractImageUrls,
  extractLogoUrl,
  extractSite,
  extractTaglines,
  metaContent,
  visibleText,
} from './extract-site.js';

const BASE = 'https://priyasarees.example';

describe('extractColors', () => {
  it('ranks a declared brand variable above a colour merely used a lot', () => {
    const css = `
      :root { --brand-primary: #7c2d12; }
      .a { border-color: #00ff00; }
      .b { border-color: #00ff00; }
      .c { border-color: #00ff00; }
    `;
    const colors = extractColors(`<style>${css}</style>`, []);
    expect(colors[0]?.hex).toBe('#7c2d12');
    expect(colors[0]?.role).toBe('primary');
  });

  it('normalises shorthand, rgb() and hsl() to the same six-digit hex', () => {
    const css = `
      .a { color: #f0a; }
      .b { color: rgb(255, 0, 170); }
      .c { color: hsl(320, 100%, 50%); }
    `;
    const colors = extractColors(`<style>${css}</style>`, []);
    const hexes = colors.map((color) => color.hex);
    expect(new Set(hexes).size).toBe(1);
    expect(hexes[0]).toBe('#ff00aa');
  });

  it('drops the alpha channel from an eight-digit hex', () => {
    const colors = extractColors('<style>.a { color: #7c2d1280; }</style>', []);
    expect(colors[0]?.hex).toBe('#7c2d12');
  });

  it('reads colours out of linked stylesheets, not just inline blocks', () => {
    const colors = extractColors('<html></html>', [':root { --primary: #123456; }']);
    expect(colors[0]?.hex).toBe('#123456');
  });

  it('treats a theme-color meta tag as the strongest signal there is', () => {
    const html = `
      <meta name="theme-color" content="#f59e0b">
      <style>:root { --brand-primary: #7c2d12; }</style>
    `;
    expect(extractColors(html, [])[0]?.hex).toBe('#f59e0b');
  });

  it('reads a role from the property when the name gives no clue', () => {
    const colors = extractColors('<style>.hero { background-color: #102030; }</style>', []);
    expect(colors[0]?.role).toBe('background');
  });
});

describe('brandPalette', () => {
  /**
   * The reason neutrals are filtered rather than merely ranked: every site is
   * mostly white and near-black, so an unfiltered top-three is #ffffff,
   * #000000 and #f8f8f8 — which reaches the brief as "work these brand colours
   * into the palette" and produces a poster washed in off-white.
   */
  it('excludes white, black and greys from the brand palette', () => {
    const css = `
      .a { color: #ffffff; }
      .b { color: #000000; }
      .c { color: #f8f8f8; }
      .d { color: #7c2d12; }
    `;
    const palette = brandPalette(extractColors(`<style>${css}</style>`, []));
    expect(palette).toContain('#7c2d12');
    expect(palette).not.toContain('#ffffff');
    expect(palette).not.toContain('#000000');
    expect(palette).not.toContain('#f8f8f8');
  });

  it('caps at the three colours the Brand Kit holds', () => {
    const css = ['#7c2d12', '#f59e0b', '#1d4ed8', '#16a34a', '#db2777']
      .map((hex, i) => `.c${i} { border-color: ${hex}; }`)
      .join('\n');
    expect(brandPalette(extractColors(`<style>${css}</style>`, [])).length).toBe(3);
  });
});

describe('extractFonts', () => {
  it('picks up a Google Fonts link', () => {
    const html =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap">';
    expect(extractFonts(html, []).map((f) => f.family)).toContain('Playfair Display');
  });

  it('takes the role from a named variable where the site declares one', () => {
    const css = `
      :root { --font-heading: "Playfair Display", serif; --font-body: Inter, sans-serif; }
    `;
    const fonts = extractFonts(`<style>${css}</style>`, []);
    expect(fonts.find((f) => f.family === 'Playfair Display')?.role).toBe('heading');
    expect(fonts.find((f) => f.family === 'Inter')?.role).toBe('body');
  });

  it('ignores generic and system fallbacks, which are not a brand choice', () => {
    const css = `
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
      h1 { font-family: "Cormorant Garamond", serif; }
    `;
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Cormorant Garamond']);
  });

  it('ignores a var() reference, which is not a family name', () => {
    const css = 'body { font-family: var(--font-sans); }';
    expect(extractFonts(`<style>${css}</style>`, [])).toEqual([]);
  });

  /**
   * Both of these came from running the extractor against a live retail site,
   * which reported its brand typography as "Font Awesome 5 Free, Font Awesome
   * 5 Brands, 300, 400" — an icon set and two font weights.
   */
  it('ignores icon fonts, which are glyph sets rather than brand typefaces', () => {
    const css = `
      @font-face { font-family: "Font Awesome 5 Free"; src: url(fa.woff2); }
      @font-face { font-family: "Material Icons"; src: url(mi.woff2); }
      h1 { font-family: "Cormorant Garamond", serif; }
    `;
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Cormorant Garamond']);
  });

  it('does not mistake a font-weight variable for a family', () => {
    const css = `
      :root {
        --font-weight-light: 300;
        --font-weight-normal: 400;
        --font-size-base: 16px;
        --font-family-base: Inter, sans-serif;
      }
    `;
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Inter']);
  });

  /** Also from a live run: stripe.com reported a typeface called "6lvh". */
  it('rejects a bare length in any unit, including ones CSS added recently', () => {
    const css = ':root { --heading-font: 6lvh; --title-font: 1.5rem; --brand-font: Sohne; }';
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Sohne']);
  });

  /** Live run again: chumbak.com reported `JudgemeStar' !important` as a
   *  separate typeface from `JudgemeStar`. */
  it('strips !important rather than letting it into the family name', () => {
    const css = `
      .a { font-family: 'Nunito Sans' !important; }
      .b { font-family: 'Nunito Sans'; }
    `;
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Nunito Sans']);
  });

  it('merges two spellings of one family, keeping the readable one', () => {
    const css = `
      @font-face { font-family: "OpenSans"; src: url(os.woff2); }
      body { font-family: "Open Sans", sans-serif; }
      h1 { font-family: "Open Sans", sans-serif; }
    `;
    const families = extractFonts(`<style>${css}</style>`, []).map((f) => f.family);
    expect(families).toEqual(['Open Sans']);
  });
});

describe('metaContent', () => {
  it('reads both name= and property= forms', () => {
    expect(metaContent('<meta name="description" content="Hand-woven silk">', 'description')).toBe(
      'Hand-woven silk',
    );
    expect(
      metaContent('<meta property="og:description" content="Since 1974">', 'og:description'),
    ).toBe('Since 1974');
  });

  it('reads the attributes in either order', () => {
    expect(metaContent('<meta content="Reversed" name="description">', 'description')).toBe(
      'Reversed',
    );
  });

  it('decodes entities', () => {
    expect(metaContent('<meta name="description" content="Silk &amp; gold">', 'description')).toBe(
      'Silk & gold',
    );
  });
});

describe('visibleText', () => {
  /**
   * Scripts have to go before tags are stripped. A minified bundle is mostly
   * braces and semicolons, and left in it swamps the excerpt the analyser
   * reads — which then characterises the brand from JavaScript.
   */
  it('removes script and style bodies entirely', () => {
    const html = `
      <script>const a = {b: 1}; window.x = "buy now";</script>
      <style>.a { color: red; }</style>
      <p>Hand-woven Banarasi silk since 1974.</p>
    `;
    const text = visibleText(html);
    expect(text).toBe('Hand-woven Banarasi silk since 1974.');
  });

  it('keeps block boundaries as line breaks rather than running words together', () => {
    expect(visibleText('<p>First</p><p>Second</p>')).toBe('First\nSecond');
  });
});

describe('extractLogoUrl', () => {
  it('prefers og:image over a favicon', () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <meta property="og:image" content="/share.png">
    `;
    expect(extractLogoUrl(html, BASE)).toBe(`${BASE}/share.png`);
  });

  it('resolves a relative href against the page it was found on', () => {
    const html = '<link rel="apple-touch-icon" href="../icons/touch.png">';
    expect(extractLogoUrl(html, `${BASE}/about/team`)).toBe(`${BASE}/icons/touch.png`);
  });

  it('skips a data: URI, which is a placeholder rather than a logo', () => {
    const html = '<img class="logo" src="data:image/gif;base64,R0lGOD">';
    expect(extractLogoUrl(html, BASE)).toBeNull();
  });

  it('returns null when the page offers nothing', () => {
    expect(extractLogoUrl('<html><body>Hello</body></html>', BASE)).toBeNull();
  });
});

describe('extractFontWeights', () => {
  it('reads the weights a Google Fonts URL actually loads', () => {
    // More reliable than counting declarations: this is what the brand paid to
    // download, not every value some rule happens to set.
    const html =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700">';
    expect(extractFontWeights(html, [])).toEqual([300, 400, 700]);
  });

  it('folds keyword weights into their numeric equivalents', () => {
    // `bold` and `700` are one typographic choice, not two.
    const css = '.a { font-weight: bold; } .b { font-weight: 700; } .c { font-weight: normal; }';
    expect(extractFontWeights(`<style>${css}</style>`, [])).toEqual([400, 700]);
  });

  it('ignores values outside the legal range', () => {
    const css = '.a { font-weight: 400; } .b { font-weight: 9999; }';
    expect(extractFontWeights(`<style>${css}</style>`, [])).toEqual([400]);
  });
});

describe('extractHeadingCasing', () => {
  it('detects all-caps headings, a deliberate and very visible choice', () => {
    expect(extractHeadingCasing(['SHOP THE SALE', 'NEW ARRIVALS NOW', 'OUR STORY TOLD'])).toBe(
      'uppercase',
    );
  });

  it('reports mixed when the headings disagree', () => {
    expect(extractHeadingCasing(['Shop the sale', 'NEW ARRIVALS NOW', 'Our latest story'])).toBe(
      'mixed',
    );
  });

  it('ignores single words, which are nav labels rather than headings', () => {
    // "SHOP" and "CART" say nothing about how the brand sets its headings.
    expect(extractHeadingCasing(['SHOP', 'SALE', 'CART'])).toBeNull();
  });

  it('returns null rather than guessing from too little evidence', () => {
    expect(extractHeadingCasing(['Only one real heading here'])).toBeNull();
    expect(extractHeadingCasing([])).toBeNull();
  });
});

describe('extractTaglines', () => {
  it('keeps brand promises and drops nav labels', () => {
    const html = '<meta property="og:title" content="Handwoven silk, made to last">';
    const taglines = extractTaglines(html, ['Shop', 'Cart', 'Woven by artisans in Varanasi']);
    expect(taglines).toContain('Handwoven silk, made to last');
    expect(taglines).toContain('Woven by artisans in Varanasi');
    expect(taglines).not.toContain('Shop');
  });

  it('de-duplicates case-insensitively', () => {
    const html = '<meta name="description" content="Woven by artisans in Varanasi">';
    expect(extractTaglines(html, ['woven by artisans in varanasi'])).toHaveLength(1);
  });
});

describe('extractImageUrls', () => {
  it('leads with og:image, the one image the brand deliberately chose', () => {
    const html = '<meta property="og:image" content="/social.jpg"><img src="/photo-1.jpg">';
    expect(extractImageUrls(html, BASE, null)[0]).toBe(`${BASE}/social.jpg`);
  });

  it('excludes the logo, which is a mark rather than photography', () => {
    const logo = `${BASE}/logo.png`;
    const html = '<meta property="og:image" content="/logo.png"><img src="/photo.jpg">';
    const urls = extractImageUrls(html, BASE, logo);
    expect(urls).not.toContain(logo);
    expect(urls).toContain(`${BASE}/photo.jpg`);
  });

  it('skips sprites, icons, tracking pixels and svg', () => {
    const html = `
      <img src="/sprite.png"><img src="/tracking-pixel.gif"><img src="/mark.svg">
      <img src="/lifestyle.jpg">
    `;
    expect(extractImageUrls(html, BASE, null)).toEqual([`${BASE}/lifestyle.jpg`]);
  });

  it('takes the largest rendition out of a srcset', () => {
    const html = '<img srcset="/small.jpg 400w, /large.jpg 1600w" src="/fallback.jpg">';
    expect(extractImageUrls(html, BASE, null)).toEqual([`${BASE}/large.jpg`]);
  });

  it('skips images the markup itself labels as a logo', () => {
    const html = '<img class="header-logo" src="/brandmark.jpg"><img src="/scene.jpg">';
    expect(extractImageUrls(html, BASE, null)).toEqual([`${BASE}/scene.jpg`]);
  });
});

describe('extractSite', () => {
  const richPage = `
    <html><head>
      <title>Priya Sarees — Handwoven Banarasi Silk</title>
      <meta name="description" content="A Jaipur boutique since 1974.">
      <style>:root { --brand-primary: #7c2d12; --font-heading: "Playfair Display", serif; }</style>
    </head><body>
      <h1>Handwoven in Banaras</h1>
      <h2>Three generations of weavers</h2>
      <p>${'Every saree is woven on a pit loom by hand. '.repeat(12)}</p>
    </body></html>
  `;

  it('reads a full page into every field', () => {
    const { extraction, looksEmpty } = extractSite({
      html: richPage,
      stylesheets: [],
      finalUrl: BASE,
    });

    expect(looksEmpty).toBe(false);
    expect(extraction.title).toBe('Priya Sarees — Handwoven Banarasi Silk');
    expect(extraction.description).toBe('A Jaipur boutique since 1974.');
    expect(extraction.headings).toContain('Handwoven in Banaras');
    expect(extraction.colors[0]?.hex).toBe('#7c2d12');
    expect(extraction.fonts[0]?.family).toBe('Playfair Display');
  });

  /**
   * The case worth reporting honestly rather than papering over. A
   * client-rendered site ships a shell, so there is no copy to read a voice
   * from — but the stylesheets are served in full, so the palette survives.
   * Telling the user exactly that beats handing the analyser a nav bar and
   * letting it invent a brand from six words.
   */
  it('flags a JavaScript-rendered shell as empty while still keeping its palette', () => {
    const shell = `
      <html><head>
        <title>My App</title>
        <style>:root { --brand-primary: #1d4ed8; }</style>
      </head><body><div id="root"></div><script>hydrate();</script></body></html>
    `;
    const { extraction, looksEmpty } = extractSite({
      html: shell,
      stylesheets: [],
      finalUrl: BASE,
    });

    expect(looksEmpty).toBe(true);
    expect(extraction.colors[0]?.hex).toBe('#1d4ed8');
  });
});
