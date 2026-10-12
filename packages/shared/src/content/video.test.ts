import { describe, expect, it } from 'vitest';
import { videoGenerationRequestSchema } from './video.js';

const base = {
  brandId: 'brand-1',
  productId: 'product-1',
  campaignType: 'generic',
  styleTemplate: 'studio_white',
};

describe('videoGenerationRequestSchema', () => {
  it('keeps the Create page request valid and a Reel by default', () => {
    const parsed = videoGenerationRequestSchema.parse(base);
    expect(parsed).toMatchObject({ width: 1080, height: 1920 });
  });

  it('accepts landscape but not square', () => {
    expect(
      videoGenerationRequestSchema.safeParse({ ...base, width: 1920, height: 1080 }).success,
    ).toBe(true);
    expect(
      videoGenerationRequestSchema.safeParse({ ...base, width: 1080, height: 1080 }).success,
    ).toBe(false);
  });

  it("only accepts the brand's own uploads as references", () => {
    const own = 'brands/brand-1/references/abc-123.jpg';
    const other = 'brands/brand-2/references/abc-123.jpg';
    const ok = (extra: object) =>
      videoGenerationRequestSchema.safeParse({ ...base, ...extra }).success;

    expect(
      ok({
        references: [{ key: own, role: 'look' }],
        sampleVideoKey: 'brands/brand-1/references/x.mp4',
      }),
    ).toBe(true);
    expect(ok({ references: [{ key: other, role: 'look' }] })).toBe(false);
    expect(ok({ sampleVideoKey: 'brands/brand-2/references/x.mp4' })).toBe(false);
    // Not a references key at all, a video as an image, or a path escape.
    expect(ok({ references: [{ key: 'brands/brand-1/products/p/x.jpg', role: 'look' }] })).toBe(
      false,
    );
    expect(ok({ references: [{ key: 'brands/brand-1/references/x.mp4', role: 'look' }] })).toBe(
      false,
    );
    expect(ok({ sampleVideoKey: 'brands/brand-1/references/../x.mp4' })).toBe(false);
  });

  it('takes a YouTube watch link as the sample, but not alongside an upload', () => {
    const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const ok = (extra: object) =>
      videoGenerationRequestSchema.safeParse({ ...base, ...extra }).success;
    expect(ok({ sampleVideoUrl: youtube })).toBe(true);
    expect(ok({ sampleVideoUrl: 'https://evil.example/watch?v=dQw4w9WgXcQ' })).toBe(false);
    expect(ok({ sampleVideoUrl: youtube, sampleVideoKey: 'brands/brand-1/references/x.mp4' })).toBe(
      false,
    );
  });
});
