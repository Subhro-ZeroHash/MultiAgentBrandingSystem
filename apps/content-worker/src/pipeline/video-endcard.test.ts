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
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/f.ttf', 4);
    expect(filter).toContain('expansion=none');
  });

  it('quotes the enable expression so its comma is not read as a filter break', () => {
    // `between(t,4,99999)` unquoted splits the filter chain at the comma and
    // ffmpeg then looks for a filter literally named '4'.
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/f.ttf', 4);
    expect(filter).toContain("enable='between(t,4.000,99999)'");
  });

  it('omits the cta layers entirely when there is no cta', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/f.ttf', 4);
    // Premium design has headline shadow + headline text = 2 drawtext layers.
    expect(filter.match(/drawtext/g)).toHaveLength(2);
  });

  it('draws the cta as its own layer when given one', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', '/tmp/c.txt', '/tmp/f.ttf', 4);
    // Headline shadow + headline + cta = 3 drawtext layers.
    expect(filter.match(/drawtext/g)).toHaveLength(3);
    expect(filter).toContain('/tmp/c.txt');
  });

  it('includes gradient scrim drawbox layers', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/f.ttf', 4);
    // Two gradient drawbox layers (upper + lower).
    expect(filter.match(/drawbox/g)).toHaveLength(2);
  });

  it('adds pill box drawbox layers when a cta is present', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', '/tmp/c.txt', '/tmp/f.ttf', 4);
    // 2 gradient scrim + 2 pill (fill + border) = 4 drawbox layers.
    expect(filter.match(/drawbox/g)).toHaveLength(4);
  });

  it('headline uses the larger w/11 font size', () => {
    const filter = buildEndCardFilter('/tmp/h.txt', null, '/tmp/f.ttf', 4);
    expect(filter).toContain('fontsize=w/11');
  });
});
