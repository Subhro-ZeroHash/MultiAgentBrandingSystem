import { describe, expect, it } from 'vitest';
import { OUTPUT_FORMAT_DIMENSIONS } from '@bmas/shared';
import { imageSizeFor, nearestAspectRatio } from './gemini.image.js';

/**
 * Gemini accepts only a fixed set of aspect ratios, so every requested output
 * size has to be mapped onto the closest one and fitted afterwards. Picking the
 * wrong neighbour means the crop throws away part of the composition — and the
 * text the QA stage is about to look for often sits in exactly that margin.
 */
describe('nearestAspectRatio', () => {
  it.each([
    ['square', 1080, 1080, '1:1'],
    ['portrait story', 1080, 1920, '9:16'],
    ['landscape banner', 1920, 1080, '16:9'],
    ['classic portrait', 600, 800, '3:4'],
    ['classic landscape', 800, 600, '4:3'],
    ['tall portrait', 1000, 1500, '2:3'],
    ['wide landscape', 1500, 1000, '3:2'],
    ['ultrawide', 2100, 900, '21:9'],
  ])('maps %s (%ix%i) to %s', (_label, width, height, expected) => {
    expect(nearestAspectRatio(width, height)).toBe(expected);
  });

  it('maps every supported output format to a real ratio', () => {
    // A format added to the shared enum without a sane ratio here would silently
    // generate at the wrong shape rather than fail.
    const supported = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']);
    for (const [format, { width, height }] of Object.entries(OUTPUT_FORMAT_DIMENSIONS)) {
      expect(supported, `${format} produced an unsupported ratio`).toContain(
        nearestAspectRatio(width, height),
      );
    }
  });

  it('picks the nearest neighbour for A4, which matches nothing exactly', () => {
    // 2480x3508 is 0.707 wide-over-tall. Its neighbours are 2:3 (0.667) and
    // 3:4 (0.750), so 2:3 wins by 0.040 to 0.043 — close enough that comparing
    // in height-over-width instead would flip the answer. The comparison is
    // done in width/height, and this pins that choice.
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.poster_a4;
    expect(nearestAspectRatio(width, height)).toBe('2:3');
  });

  it('is orientation-sensitive', () => {
    expect(nearestAspectRatio(1080, 1920)).not.toBe(nearestAspectRatio(1920, 1080));
  });

  it('depends on the ratio, not the absolute size', () => {
    expect(nearestAspectRatio(100, 100)).toBe(nearestAspectRatio(4000, 4000));
  });
});

describe('imageSizeFor', () => {
  it.each([
    [1080, 1080, '1K'],
    [1280, 720, '1K'],
    [1080, 1920, '2K'],
    [2560, 1440, '2K'],
    [2480, 3508, '4K'],
  ])('asks for %ix%i at %s', (width, height, expected) => {
    expect(imageSizeFor(width, height)).toBe(expected);
  });

  it('judges by the long edge whichever way round it is', () => {
    expect(imageSizeFor(3508, 2480)).toBe(imageSizeFor(2480, 3508));
  });

  /**
   * poster_a4 is the only format whose long edge clears 2560, so it is the only
   * one that asks for 4K — and 4K is the tier with its own request budget,
   * because three concurrent variants there measured 232-257s against 90s for a
   * single one. A flat timeout sized for the other formats failed A4 every run.
   */
  it('is the only format reaching the 4K tier', () => {
    const tiers = Object.entries(OUTPUT_FORMAT_DIMENSIONS).map(
      ([format, { width, height }]) => [format, imageSizeFor(width, height)] as const,
    );
    expect(tiers.filter(([, tier]) => tier === '4K').map(([format]) => format)).toEqual([
      'poster_a4',
    ]);
  });
});
