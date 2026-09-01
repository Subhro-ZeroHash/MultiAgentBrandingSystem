import { describe, expect, it } from 'vitest';
import { AiRegistry } from './registry.js';

describe('AiRegistry.videoGeneratorFallbackChain', () => {
  it('defaults to LTX primary, Gemini fallback', () => {
    const chain = new AiRegistry({}).videoGeneratorFallbackChain();
    expect(chain.map((service) => service.provider)).toEqual(['ltx', 'google']);
  });

  it('puts the configured primary first, Gemini still second', () => {
    // Only real alternative to the ltx default today; still exercises "the
    // configured primary" rather than a hardcoded 'ltx', so this doesn't
    // silently stop meaning anything if the default ever changes.
    const chain = new AiRegistry({ videoProviderPrimary: 'ltx' }).videoGeneratorFallbackChain();
    expect(chain.map((service) => service.provider)).toEqual(['ltx', 'google']);
  });

  it('never duplicates Gemini as its own fallback', () => {
    const chain = new AiRegistry({ videoProviderPrimary: 'google' }).videoGeneratorFallbackChain();
    expect(chain.map((service) => service.provider)).toEqual(['google']);
  });

  it('never escalates a stub-configured run to a real, billed provider', () => {
    const chain = new AiRegistry({ videoProviderPrimary: 'stub' }).videoGeneratorFallbackChain();
    expect(chain.map((service) => service.provider)).toEqual(['stub']);
  });
});
