import { describe, expect, it } from 'vitest';
import { AiRegistry } from './registry.js';

describe('AiRegistry.videoGenerator', () => {
  it('defaults to the configured primary with no argument', () => {
    expect(new AiRegistry({}).videoGenerator().provider).toBe('ltx');
    expect(new AiRegistry({ videoProviderPrimary: 'google' }).videoGenerator().provider).toBe(
      'google',
    );
  });

  it('an explicit provider argument overrides the configured primary', () => {
    const registry = new AiRegistry({ videoProviderPrimary: 'ltx' });
    expect(registry.videoGenerator('google').provider).toBe('google');
    expect(registry.videoGenerator('ltx').provider).toBe('ltx');
  });

  it('falls back to ltx with no config and no argument at all', () => {
    expect(new AiRegistry({}).videoGenerator().provider).toBe('ltx');
  });
});
