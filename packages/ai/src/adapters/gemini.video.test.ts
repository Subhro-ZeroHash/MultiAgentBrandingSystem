import { describe, expect, it } from 'vitest';
import { nearestVeoDuration, nearestVeoResolution } from './gemini.video.js';

describe('nearestVeoResolution', () => {
  it('maps an exact 1080p landscape request to itself', () => {
    expect(nearestVeoResolution(1920, 1080)).toEqual({
      width: 1920,
      height: 1080,
      tier: 1080,
      resolution: '1080p',
      aspectRatio: '16:9',
    });
  });

  it('maps the equivalent portrait request to the portrait pair and 9:16', () => {
    expect(nearestVeoResolution(1080, 1920)).toEqual({
      width: 1080,
      height: 1920,
      tier: 1080,
      resolution: '1080p',
      aspectRatio: '9:16',
    });
  });

  it('snaps a sub-720p request up to 720p, never down', () => {
    expect(nearestVeoResolution(640, 360)).toMatchObject({ tier: 720, resolution: '720p' });
  });

  it('caps at 1080p for a request beyond it — Veo has no higher tier here', () => {
    expect(nearestVeoResolution(3840, 2160)).toMatchObject({ tier: 1080, resolution: '1080p' });
  });

  it('reads orientation from which edge is longer, not from width alone', () => {
    const landscape = nearestVeoResolution(1280, 720);
    const portrait = nearestVeoResolution(720, 1280);
    expect(landscape.aspectRatio).toBe('16:9');
    expect(portrait.aspectRatio).toBe('9:16');
  });
});

describe('nearestVeoDuration', () => {
  it('snaps up to the next supported clip length, never down', () => {
    expect(nearestVeoDuration(5)).toBe(6);
  });

  it('leaves an exact match untouched', () => {
    expect(nearestVeoDuration(6)).toBe(6);
  });

  it('caps at 8 seconds for anything longer', () => {
    expect(nearestVeoDuration(20)).toBe(8);
  });

  it('floors at 4 seconds for anything shorter', () => {
    expect(nearestVeoDuration(1)).toBe(4);
  });
});
