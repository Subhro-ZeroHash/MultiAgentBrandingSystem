import { describe, expect, it } from 'vitest';
import { buildEndCardFilter, wrapText } from './video-endcard.js';

describe('wrapText', () => {
  it('leaves a line that already fits alone', () => {
    // Default maxChars is now 20 (up from 16 in the old endcard).
    expect(wrapText('Festive Sale', 20)).toEqual(['Festive Sale']);
  });

  it('breaks on whitespace once the limit is passed', () => {
    expect(wrapText('Handwoven silk for the festive season', 20)).toEqual([
      'Handwoven silk for',
      'the festive season',
    ]);
  });

  it('keeps a word longer than the limit intact rather than hyphenating it', () => {
    // Breaking mid-word renders a different word; overflowing is merely ugly.
    expect(wrapText('Unbelievablyoversizedword now', 20)).toEqual([
      'Unbelievablyoversizedword',
      'now',
    ]);
  });

  it('collapses the whitespace a model leaves behind', () => {
    expect(wrapText('  Big   sale\n\nthis week  ', 20)).toEqual(['Big sale this week']);
  });

  it('returns nothing for text that is only whitespace', () => {
    expect(wrapText('   ', 20)).toEqual([]);
  });
});

describe('buildEndCardFilter', () => {
  it('disables drawtext expansion so a percentage survives', () => {
    // Regression: without this, drawtext reads '%' as the start of its own
    // template syntax and drops it — so "50% off", the single most likely
    // offer headline there is, rendered as "50 off" with a "Stray %" warning.
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    expect(filter).toContain('expansion=none');
  });

  it('quotes the enable expression so its comma is not read as a filter break', () => {
    // `between(t,4,99999)` unquoted splits the filter chain at the comma and
    // ffmpeg then looks for a filter literally named '4'.
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    expect(filter).toContain("enable='between(t,4.000,99999)'");
  });

  it('omits the cta layers entirely when there is no cta', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    // Headline shadow + headline text = 2 drawtext layers.
    expect(filter.match(/drawtext/g)).toHaveLength(2);
  });

  it('draws the cta as its own layer when given one', () => {
    const filter = buildEndCardFilter(
      '/tmp/h.txt',
      '/tmp/c.txt',
      '/tmp/bold.ttf',
      '/tmp/reg.ttf',
      4,
    );
    // Headline shadow + headline + cta = 3 drawtext layers.
    expect(filter.match(/drawtext/g)).toHaveLength(3);
    expect(filter).toContain('/tmp/c.txt');
  });

  it('includes the scrim drawbox layer', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    expect(filter.match(/drawbox/g)).toHaveLength(1);
  });

  it('adds pill box drawbox layers when a cta is present', () => {
    const filter = buildEndCardFilter(
      '/tmp/h.txt',
      '/tmp/c.txt',
      '/tmp/bold.ttf',
      '/tmp/reg.ttf',
      4,
    );
    // 1 scrim + 2 pill (fill + border) = 3 drawbox layers.
    expect(filter.match(/drawbox/g)).toHaveLength(3);
  });

  it('headline uses the bold font file and the larger w/11 font size', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    expect(filter).toContain('fontsize=w/11');
    // Both headline drawtext layers (shadow + main) use the bold file.
    expect(filter.match(/fontfile='\/tmp\/bold\.ttf'/g)).toHaveLength(2);
  });

  it('cta text uses the regular font file, not the bold one', () => {
    const filter = buildEndCardFilter(
      '/tmp/h.txt',
      '/tmp/c.txt',
      '/tmp/bold.ttf',
      '/tmp/reg.ttf',
      4,
    );
    expect(filter).toContain("textfile='/tmp/c.txt':fontfile='/tmp/reg.ttf'");
  });

  it('centres a CTA-less headline within the whole scrim, not a fixed slot', () => {
    // Regression: a fixed y percentage put a two-line headline half inside a
    // lighter, low-opacity band and half in the solid one. Centering must be
    // driven by text_h so it works for a one-line headline too.
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/bold.ttf', '/tmp/reg.ttf', 4);
    expect(filter).toContain('text_h');
    expect(filter).not.toContain('h*0.62');
  });

  it('sizes every drawbox off ih/iw, never off its own w/h', () => {
    // Regression: unlike drawtext (where w/h mean the frame's size), in
    // drawbox w/h mean the BOX's own width/height. `h=0.42*h` is circular —
    // ffmpeg fails "Error when evaluating the expression" and the whole
    // filter graph never configures, so burnEndCard silently falls back to
    // posting the clip with no end card at all. Verified against a real
    // ffmpeg 6.1.1 render, not just this string assertion.
    const filter = buildEndCardFilter(
      '/tmp/h.txt',
      '/tmp/c.txt',
      '/tmp/bold.ttf',
      '/tmp/reg.ttf',
      4,
    );
    for (const box of filter.split(',').filter((f) => f.startsWith('drawbox'))) {
      for (const [, value] of box.matchAll(/[xywh]=([^:]*)/g)) {
        expect(value).not.toMatch(/(?<![a-zA-Z])h(?![a-zA-Z])/);
      }
      expect(box).toContain('ih');
    }
  });
});
