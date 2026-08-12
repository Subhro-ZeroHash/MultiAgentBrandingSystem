import { describe, expect, it } from 'vitest';
import { creativeKey, thumbnailKey } from './storage.js';

/**
 * Keys are the only thing tying a stored object back to the job that made it,
 * and a collision silently destroys a paid-for image rather than erroring.
 */
describe('creativeKey', () => {
  it('groups by brand then job so a prefix scan finds a job’s output', () => {
    expect(creativeKey('brand-1', 'job-1', 1, 'jpg')).toBe(
      'brands/brand-1/generations/job-1/variant-1.jpg',
    );
  });

  it('keeps a regenerated variant distinct from the one it replaces', () => {
    // The original stays the fallback when the retry also fails QA, so the two
    // must never share a key.
    const original = creativeKey('brand-1', 'job-1', 2, 'jpg');
    const retry = creativeKey('brand-1', 'job-1', 2, 'jpg', 1);
    expect(retry).not.toBe(original);
    expect(retry).toBe('brands/brand-1/generations/job-1/variant-2-r1.jpg');
  });

  it('keeps successive rounds distinct from each other', () => {
    expect(creativeKey('b', 'j', 1, 'jpg', 1)).not.toBe(creativeKey('b', 'j', 1, 'jpg', 2));
  });

  it('treats round 0 as the first pass, with no suffix', () => {
    expect(creativeKey('b', 'j', 1, 'jpg', 0)).toBe(creativeKey('b', 'j', 1, 'jpg'));
  });

  it('keeps variants within a job distinct', () => {
    expect(creativeKey('b', 'j', 1, 'jpg')).not.toBe(creativeKey('b', 'j', 2, 'jpg'));
  });
});

describe('thumbnailKey', () => {
  it('sits beside its variant so the pair cannot be orphaned', () => {
    expect(thumbnailKey('brands/b/generations/j/variant-1.jpg')).toBe(
      'brands/b/generations/j/variant-1-thumb.jpg',
    );
  });

  it('is always .jpg whatever the source extension', () => {
    // Thumbnails are re-encoded as JPEG; a PNG thumbnail of a photograph is
    // several times the size for no visible gain.
    expect(thumbnailKey('a/b/variant-1.png')).toMatch(/\.jpg$/);
    expect(thumbnailKey('a/b/variant-1.webp')).toMatch(/\.jpg$/);
  });

  it('does not collide with the variant it describes', () => {
    const key = 'brands/b/generations/j/variant-1.jpg';
    expect(thumbnailKey(key)).not.toBe(key);
  });

  it('keeps regenerated variants’ thumbnails distinct too', () => {
    expect(thumbnailKey(creativeKey('b', 'j', 1, 'jpg', 1))).not.toBe(
      thumbnailKey(creativeKey('b', 'j', 1, 'jpg')),
    );
  });

  it('only replaces the final extension', () => {
    expect(thumbnailKey('a.b/c.d/variant-1.jpg')).toBe('a.b/c.d/variant-1-thumb.jpg');
  });
});
