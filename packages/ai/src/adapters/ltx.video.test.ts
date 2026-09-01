import { describe, expect, it } from 'vitest';
import { clampDuration, nearestVideoResolution } from './ltx.video.js';

describe('nearestVideoResolution', () => {
  it('maps an exact 1080p landscape request to itself', () => {
    expect(nearestVideoResolution(1920, 1080)).toEqual({ width: 1920, height: 1080, tier: 1080 });
  });

  it('maps the equivalent portrait request to the portrait pair, not a scaled one', () => {
    expect(nearestVideoResolution(1080, 1920)).toEqual({ width: 1080, height: 1920, tier: 1080 });
  });

  it('snaps a request between two tiers up to the next one, never down', () => {
    // Between 720 and 1080 — a request for less must never render smaller
    // than what was asked.
    expect(nearestVideoResolution(1600, 900).tier).toBe(1080);
  });

  it('caps at the highest tier for a request beyond it', () => {
    expect(nearestVideoResolution(7680, 4320).tier).toBe(2160);
  });

  it('reads orientation from which edge is longer, not from width alone', () => {
    const landscape = nearestVideoResolution(1280, 720);
    const portrait = nearestVideoResolution(720, 1280);
    expect(landscape.width).toBeGreaterThan(landscape.height);
    expect(portrait.height).toBeGreaterThan(portrait.width);
  });
});

describe('clampDuration', () => {
  it('rounds a fractional request to a whole second', () => {
    expect(clampDuration(5.6)).toBe(6);
  });

  it('floors at 2 seconds — LTX rejects anything shorter with a 400', () => {
    expect(clampDuration(0)).toBe(2);
    expect(clampDuration(-5)).toBe(2);
    expect(clampDuration(1)).toBe(2);
  });

  it("caps at LTX's documented 20-second ceiling", () => {
    expect(clampDuration(45)).toBe(20);
  });

  it('leaves an in-range whole number untouched', () => {
    expect(clampDuration(8)).toBe(8);
  });
});
