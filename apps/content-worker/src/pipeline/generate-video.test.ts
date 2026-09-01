import type { Brand } from '@bmas/db';
import type { VideoGenerationRequest } from '@bmas/shared';
import { describe, expect, it } from 'vitest';
import type { WorkerContext } from '../context.js';
import { composeVideoBrief, validateVideo } from './generate-video.js';

/** A minimal, real MP4 header — 'ftyp' at byte offset 4, same as any real
 *  ISO-BMFF file, followed by padding so it clears the size floor. */
const validMp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(2048),
]);

describe('validateVideo', () => {
  it('accepts a well-formed video within its requested duration', () => {
    expect(() => validateVideo(validMp4, 6, 6)).not.toThrow();
  });

  it('rejects a file too small to be a real video, likely a truncated download', () => {
    const truncated = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftypisom'),
    ]);
    expect(() => validateVideo(truncated, 6, 6)).toThrow(/truncated/);
  });

  it("rejects a buffer whose byte 4 isn't 'ftyp' — not a real MP4 container", () => {
    const notMp4 = Buffer.concat([Buffer.from('XXXXXXXX', 'ascii'), Buffer.alloc(2048)]);
    expect(() => validateVideo(notMp4, 6, 6)).toThrow(/not a valid MP4/);
  });

  it('rejects a zero or negative reported duration', () => {
    expect(() => validateVideo(validMp4, 0, 6)).toThrow(/outside the requested bound/);
  });

  it('rejects a duration meaningfully longer than what was requested', () => {
    expect(() => validateVideo(validMp4, 20, 6)).toThrow(/outside the requested bound/);
  });

  it('tolerates a small rounding overshoot rather than failing on it', () => {
    // Providers report actual rendered duration, which can round up slightly
    // past an integer request — this must not read as a provider bug.
    expect(() => validateVideo(validMp4, 6.4, 6)).not.toThrow();
  });
});

const brand = {
  name: 'Zudio',
  category: 'Mass Market Retail / Multi-Category',
  tone: ['friendly'],
} as unknown as Brand;

const baseRequest = {
  brandId: 'brand-1',
  productId: 'product-1',
  campaignType: 'generic',
  styleTemplate: 'studio_white',
} as unknown as VideoGenerationRequest;

/** Only what composeVideoBrief actually reads: one product row off `productId`.
 *  Same "fake the one query, not the database" approach stages.test.ts uses
 *  for composeBrief. */
function fakeCtx(
  product: { name: string; description: string | null; sellingPoints?: string[] } | null,
) {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(product ? [{ sellingPoints: [], ...product }] : []),
  };
  return { db: { select: () => builder } } as unknown as WorkerContext;
}

describe('composeVideoBrief', () => {
  it('names the product and folds in its description', async () => {
    const prompt = await composeVideoBrief(
      fakeCtx({ name: 'Running Shoes', description: 'Lightweight daily trainer' }),
      brand,
      baseRequest,
    );
    expect(prompt).toContain('Running Shoes');
    expect(prompt).toContain('Lightweight daily trainer');
  });

  it('includes selling points when the product has them', async () => {
    const prompt = await composeVideoBrief(
      fakeCtx({
        name: 'Shoes',
        description: null,
        sellingPoints: ['Breathable mesh', 'Recycled sole'],
      }),
      brand,
      baseRequest,
    );
    expect(prompt).toContain('Breathable mesh');
    expect(prompt).toContain('Recycled sole');
  });

  it('omits the selling-points line entirely when there are none', async () => {
    const prompt = await composeVideoBrief(
      fakeCtx({ name: 'Shoes', description: null }),
      brand,
      baseRequest,
    );
    expect(prompt).not.toContain('Key selling points');
  });

  it("includes the chosen style template's art direction", async () => {
    const prompt = await composeVideoBrief(fakeCtx({ name: 'Shoes', description: null }), brand, {
      ...baseRequest,
      styleTemplate: 'neon_gaming',
    });
    expect(prompt).toMatch(/neon/i);
  });

  it('states the campaign intent for the chosen campaign type', async () => {
    const prompt = await composeVideoBrief(fakeCtx({ name: 'Shoes', description: null }), brand, {
      ...baseRequest,
      campaignType: 'festival',
    });
    expect(prompt).toMatch(/festival campaign/i);
  });

  /** The same fencing composeBrief gives brand.category — a mass-market
   *  retailer's video for one specific product must not turn into an
   *  unrelated-merchandise showcase. */
  it("fences the brand's category as tone-only, not subject matter", async () => {
    const prompt = await composeVideoBrief(
      fakeCtx({ name: 'Shoes', description: null }),
      brand,
      baseRequest,
    );
    expect(prompt).toContain(brand.category);
    expect(prompt).toMatch(/only to judge tone/i);
  });

  it('folds in the offer and headline as mood, not as text to render', async () => {
    const prompt = await composeVideoBrief(fakeCtx({ name: 'Shoes', description: null }), brand, {
      ...baseRequest,
      headlineText: 'Big Sale',
      offerText: '30% off',
    });
    expect(prompt).toContain('Big Sale');
    expect(prompt).toContain('30% off');
    expect(prompt).toMatch(/not on-screen text|not displaying it as text/);
  });

  it('carries extraInstructions through verbatim when given', async () => {
    const prompt = await composeVideoBrief(fakeCtx({ name: 'Shoes', description: null }), brand, {
      ...baseRequest,
      extraInstructions: 'Set against a rainy monsoon backdrop',
    });
    expect(prompt).toContain('Set against a rainy monsoon backdrop');
  });

  it('throws when the product does not exist', async () => {
    await expect(composeVideoBrief(fakeCtx(null), brand, baseRequest)).rejects.toThrow(/not found/);
  });
});
