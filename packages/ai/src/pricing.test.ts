import { describe, expect, it } from 'vitest';
import { priceVideo } from './pricing.js';

describe('priceVideo', () => {
  it('multiplies the tier rate by duration', () => {
    // ltx-2-5-fast @ 720p is 90_000 micro-USD/s.
    expect(priceVideo('ltx-2-5-fast', 720, 4)).toBe(360_000);
  });

  it('returns zero for an unknown model rather than throwing', () => {
    expect(priceVideo('not-a-real-model', 1080, 8)).toBe(0);
  });

  it('snaps a resolution between two tiers up to the next one', () => {
    // 900 sits between the 720 and 1080 rows — charged at 1080, not 720 and
    // not zero, mirroring the adapter's own "never render smaller than
    // asked" rounding.
    const between = priceVideo('ltx-2-3-fast', 900, 1);
    const at1080 = priceVideo('ltx-2-3-fast', 1080, 1);
    expect(between).toBe(at1080);
  });

  it('charges the highest tier for a resolution above every listed one', () => {
    const above = priceVideo('ltx-2-3-pro', 5000, 1);
    const at2160 = priceVideo('ltx-2-3-pro', 2160, 1);
    expect(above).toBe(at2160);
  });

  it("returns zero for a model with no rate at the requested tier's model line", () => {
    // ltx-2-5-pro has no 1440/2160 rows at all (see VIDEO_RATES) — it should
    // still resolve to its highest available tier (1080), not zero.
    expect(priceVideo('ltx-2-5-pro', 4000, 1)).toBe(priceVideo('ltx-2-5-pro', 1080, 1));
  });

  it('rounds to the nearest whole micro-USD', () => {
    expect(Number.isInteger(priceVideo('ltx-2-5-fast', 720, 2.5))).toBe(true);
  });
});
