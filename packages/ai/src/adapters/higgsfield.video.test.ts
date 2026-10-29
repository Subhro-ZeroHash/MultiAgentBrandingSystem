import { describe, expect, it } from 'vitest';
import { ProviderNotConfiguredError } from '../errors.js';
import {
  HiggsfieldVideoAdapter,
  aspectRatioFor,
  clampDuration,
} from './higgsfield.video.js';

describe('aspectRatioFor', () => {
  it('maps landscape dimensions (width > height) to 16:9', () => {
    expect(aspectRatioFor(1920, 1080)).toBe('16:9');
    expect(aspectRatioFor(1280, 720)).toBe('16:9');
  });

  it('maps portrait dimensions (height > width) to 9:16', () => {
    expect(aspectRatioFor(1080, 1920)).toBe('9:16');
    expect(aspectRatioFor(720, 1280)).toBe('9:16');
  });

  it('maps square dimensions (width === height) to 1:1', () => {
    expect(aspectRatioFor(1080, 1080)).toBe('1:1');
  });
});

describe('clampDuration', () => {
  it('snaps requests of 10 seconds or more to 10 seconds', () => {
    expect(clampDuration(10)).toBe(10);
    expect(clampDuration(15)).toBe(10);
    expect(clampDuration(20)).toBe(10);
  });

  it('snaps requests of less than 10 seconds to 5 seconds', () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(4)).toBe(5);
    expect(clampDuration(0)).toBe(5);
  });
});

describe('HiggsfieldVideoAdapter configuration', () => {
  it('reports provider as higgsfield', () => {
    const adapter = new HiggsfieldVideoAdapter({ apiKey: 'test_key:test_secret' });
    expect(adapter.provider).toBe('higgsfield');
  });

  it('throws ProviderNotConfiguredError if apiKey is missing when generate is called', async () => {
    const adapter = new HiggsfieldVideoAdapter({ apiKey: undefined });
    await expect(
      adapter.generate({
        prompt: 'test prompt',
        width: 1080,
        height: 1920,
        durationSeconds: 10,
      }),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });
});
