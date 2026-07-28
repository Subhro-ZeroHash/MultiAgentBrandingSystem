import { describe, expect, it } from 'vitest';
import { OUTPUT_FORMAT_DIMENSIONS } from '@bmas/shared';
import {
  INSTAGRAM_MAX_RATIO,
  INSTAGRAM_MAX_WIDTH,
  INSTAGRAM_MIN_RATIO,
  instagramCanvas,
  needsInstagramFit,
} from './instagram-image.js';

/**
 * Instagram rejects anything outside 4:5..1.91:1. Getting this wrong does not
 * fail loudly in our code — it fails as a Meta error several steps later, after
 * the image has already been fetched, which is exactly how the poster_a4
 * publishing failure presented.
 */
describe('needsInstagramFit', () => {
  it('leaves instagram_post alone, since it is already square', () => {
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.instagram_post;
    expect(needsInstagramFit(width, height)).toBe(false);
  });

  it('flags facebook_banner, which overshoots the ceiling by a hair', () => {
    // 1200x628 is 1.9108 against a 1.91 limit. Sitting a rounding error outside
    // the range is still outside it, and the pad this triggers is about one
    // pixel of height — far cheaper than a rejected publish.
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.facebook_banner;
    expect(width / height).toBeGreaterThan(INSTAGRAM_MAX_RATIO);
    expect(width / height).toBeCloseTo(INSTAGRAM_MAX_RATIO, 2);
    expect(needsInstagramFit(width, height)).toBe(true);
  });

  it('flags poster_a4, whose ratio sits below the 4:5 floor', () => {
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.poster_a4;
    expect(width / height).toBeLessThan(INSTAGRAM_MIN_RATIO);
    expect(needsInstagramFit(width, height)).toBe(true);
  });

  it('flags story_reel_cover, which is far taller than the feed allows', () => {
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.story_reel_cover;
    expect(needsInstagramFit(width, height)).toBe(true);
  });

  it('flags an oversized but legally-shaped image on width alone', () => {
    expect(needsInstagramFit(4000, 4000)).toBe(true);
    expect(needsInstagramFit(1080, 1080)).toBe(false);
  });
});

describe('instagramCanvas', () => {
  /** The property that actually matters: whatever goes in, what comes out is
   *  something Meta will accept. */
  it.each(Object.keys(OUTPUT_FORMAT_DIMENSIONS) as Array<keyof typeof OUTPUT_FORMAT_DIMENSIONS>)(
    'produces a compliant canvas for %s',
    (format) => {
      const { width, height } = OUTPUT_FORMAT_DIMENSIONS[format];
      const fit = instagramCanvas(width, height);
      const ratio = fit.canvasWidth / fit.canvasHeight;

      expect(ratio).toBeGreaterThanOrEqual(INSTAGRAM_MIN_RATIO - 0.001);
      expect(ratio).toBeLessThanOrEqual(INSTAGRAM_MAX_RATIO + 0.001);
      expect(fit.canvasWidth).toBeLessThanOrEqual(INSTAGRAM_MAX_WIDTH);
    },
  );

  it('letterboxes A4 to 4:5 without cropping it', () => {
    const { width, height } = OUTPUT_FORMAT_DIMENSIONS.poster_a4;
    const fit = instagramCanvas(width, height);

    expect(fit.padded).toBe(true);
    expect(fit.canvasWidth / fit.canvasHeight).toBeCloseTo(INSTAGRAM_MIN_RATIO, 2);
    // The poster keeps its own shape and fits inside — nothing is cut off, which
    // is the whole reason for padding over a centre crop on a typographic layout.
    expect(fit.imageWidth / fit.imageHeight).toBeCloseTo(width / height, 2);
    expect(fit.imageWidth).toBeLessThanOrEqual(fit.canvasWidth);
    expect(fit.imageHeight).toBeLessThanOrEqual(fit.canvasHeight);
  });

  it('scales a compliant-but-huge image down without padding it', () => {
    const fit = instagramCanvas(2160, 2160);
    expect(fit.padded).toBe(false);
    expect(fit.canvasWidth).toBe(INSTAGRAM_MAX_WIDTH);
    expect(fit.canvasHeight).toBe(INSTAGRAM_MAX_WIDTH);
    expect(fit.imageWidth).toBe(fit.canvasWidth);
  });

  it('leaves an already-legal image untouched', () => {
    const fit = instagramCanvas(1080, 1080);
    expect(fit).toMatchObject({
      canvasWidth: 1080,
      canvasHeight: 1080,
      imageWidth: 1080,
      imageHeight: 1080,
      padded: false,
    });
  });

  it('pads the height of an ultra-wide image rather than trimming its sides', () => {
    const fit = instagramCanvas(2100, 900);
    expect(fit.padded).toBe(true);
    expect(fit.canvasWidth / fit.canvasHeight).toBeCloseTo(INSTAGRAM_MAX_RATIO, 2);
    expect(fit.imageWidth / fit.imageHeight).toBeCloseTo(2100 / 900, 2);
  });
});
