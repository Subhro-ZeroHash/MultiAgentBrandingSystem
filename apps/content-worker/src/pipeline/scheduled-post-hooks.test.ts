import { describe, expect, it } from 'vitest';
import { composeCaption } from './scheduled-post-hooks.js';

/**
 * Instagram rejects the whole post over 2200 characters, so an overlong caption
 * is not a cosmetic problem — it is a publish that fails hours after the user
 * approved it. Each copy field is capped individually upstream; nothing bounded
 * their sum until this function.
 */
const LIMIT = 2200;

const copy = (overrides: Partial<Parameters<typeof composeCaption>[0]> = {}) => ({
  headline: 'Fresh Brew',
  caption: 'A mug that keeps up with your morning.',
  hashtags: ['#coffee', '#morning'],
  cta: 'Shop now',
  ...overrides,
});

describe('composeCaption', () => {
  it('joins the four sections in reading order', () => {
    expect(composeCaption(copy())).toBe(
      'Fresh Brew\n\nA mug that keeps up with your morning.\n\n#coffee #morning\n\nShop now',
    );
  });

  it('omits sections that are empty rather than leaving blank gaps', () => {
    expect(composeCaption(copy({ hashtags: [], cta: '' }))).toBe(
      'Fresh Brew\n\nA mug that keeps up with your morning.',
    );
  });

  it('drops hashtags before the CTA when the caption will not fit', () => {
    // Body long enough that body + hashtags + CTA overruns, but body + CTA fits.
    const result = composeCaption(
      copy({ caption: 'x'.repeat(2100), hashtags: ['#a'.repeat(60)], cta: 'Shop now' }),
    );

    expect(result.length).toBeLessThanOrEqual(LIMIT);
    expect(result, 'the CTA is worth more than discoverability').toContain('Shop now');
    expect(result).not.toContain('#a');
  });

  it('drops the CTA too when even that will not fit', () => {
    const result = composeCaption(copy({ caption: 'x'.repeat(2180), cta: 'Shop now' }));

    expect(result.length).toBeLessThanOrEqual(LIMIT);
    expect(result).not.toContain('Shop now');
  });

  it('hard-truncates copy that overruns on headline and body alone', () => {
    const result = composeCaption(copy({ headline: 'y'.repeat(1200), caption: 'x'.repeat(1200) }));
    expect(result).toHaveLength(LIMIT);
  });

  it('never exceeds the limit across a spread of pathological inputs', () => {
    for (const size of [0, 1, 500, 2199, 2200, 2201, 5000]) {
      const result = composeCaption(
        copy({ caption: 'x'.repeat(size), hashtags: ['#tag'.repeat(size % 50)] }),
      );
      expect(result.length, `caption body of ${size} produced ${result.length}`).toBeLessThanOrEqual(
        LIMIT,
      );
    }
  });
});
