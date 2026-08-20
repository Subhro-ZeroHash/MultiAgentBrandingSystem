import { describe, expect, it } from 'vitest';
import {
  computeActionTier,
  computeOpportunityScore,
  OPPORTUNITY_SCORE_WEIGHTS,
  trendSourceSchema,
} from './trends.js';

/**
 * `computeOpportunityScore` is the single definition of the number
 * opportunities are ranked by — the model is deliberately never asked for it
 * directly, because a self-reported composite can disagree with its own
 * sub-scores (the same reasoning `computeGeoScore` in geo/visibility.ts
 * documents for the GEO headline number). A silent regression here would
 * misrank every research run without producing a single wrong-looking
 * sub-score to notice it by.
 */
describe('computeOpportunityScore', () => {
  it('weights the axes as documented, not equally', () => {
    // Perfect brand fit, mediocre everything else, vs. the reverse: brand fit
    // should win, because OPPORTUNITY_SCORE_WEIGHTS.brandRelevance ties for
    // the largest single weight (with productRelevance).
    const brandFocused = computeOpportunityScore({
      brandRelevance: 100,
      audienceRelevance: 50,
      productRelevance: 50,
      urgency: 50,
      marketingPotential: 50,
      trendScore: 50,
    });
    const trendFocused = computeOpportunityScore({
      brandRelevance: 50,
      audienceRelevance: 50,
      productRelevance: 50,
      urgency: 50,
      marketingPotential: 50,
      trendScore: 100,
    });
    expect(brandFocused).toBeGreaterThan(trendFocused);
  });

  it('scores a uniform input at that same value, up to rounding', () => {
    const score = computeOpportunityScore({
      brandRelevance: 80,
      audienceRelevance: 80,
      productRelevance: 80,
      urgency: 80,
      marketingPotential: 80,
      trendScore: 80,
    });
    expect(score).toBe(80);
  });

  it('is 0 for an all-zero input and 100 for an all-100 input', () => {
    const zero = {
      brandRelevance: 0,
      audienceRelevance: 0,
      productRelevance: 0,
      urgency: 0,
      marketingPotential: 0,
      trendScore: 0,
    };
    const hundred = {
      brandRelevance: 100,
      audienceRelevance: 100,
      productRelevance: 100,
      urgency: 100,
      marketingPotential: 100,
      trendScore: 100,
    };
    expect(computeOpportunityScore(zero)).toBe(0);
    expect(computeOpportunityScore(hundred)).toBe(100);
  });

  it('sums the documented weights to exactly 1', () => {
    // A drifted weight set would silently over- or under-scale every score —
    // worth pinning as a standalone fact about the constant, not just about
    // computeOpportunityScore's output.
    const total = Object.values(OPPORTUNITY_SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('rewards a niche-but-relevant trend over a huge-but-irrelevant one', () => {
    // The scenario the weighting exists for: an SMB gets more value from
    // "perfectly on-brand, perfectly on-product, modest reach" than "huge,
    // generic, no product tie-in".
    const nicheButRelevant = computeOpportunityScore({
      brandRelevance: 90,
      audienceRelevance: 85,
      productRelevance: 88,
      urgency: 70,
      marketingPotential: 80,
      trendScore: 20,
    });
    const hugeButGeneric = computeOpportunityScore({
      brandRelevance: 15,
      audienceRelevance: 10,
      productRelevance: 5,
      urgency: 30,
      marketingPotential: 30,
      trendScore: 95,
    });
    expect(nicheButRelevant).toBeGreaterThan(hugeButGeneric);
  });
});

describe('computeActionTier', () => {
  it('buckets at the documented thresholds', () => {
    expect(computeActionTier(100)).toBe('immediate_action');
    expect(computeActionTier(92)).toBe('immediate_action');
    expect(computeActionTier(91)).toBe('recommended');
    expect(computeActionTier(75)).toBe('recommended');
    expect(computeActionTier(74)).toBe('monitor');
    expect(computeActionTier(50)).toBe('monitor');
    expect(computeActionTier(49)).toBe('ignore');
    expect(computeActionTier(0)).toBe('ignore');
  });
});

/**
 * Both research agents build their `sources` arrays from model output, so this
 * schema is a parse boundary against a JSON-Schema-constrained model, not just
 * a type. The failure it guards is real: a run dropped `title` from a source
 * object entirely and the resulting "expected string, received undefined"
 * failed the whole intelligence synthesis, since the adapter treats a schema
 * mismatch as retryable and then gives up.
 */
describe('trendSourceSchema', () => {
  it('normalizes a missing or null title to null rather than rejecting the source', () => {
    expect(trendSourceSchema.parse({ url: 'https://example.com/a' })).toEqual({
      url: 'https://example.com/a',
      title: null,
    });
    expect(trendSourceSchema.parse({ url: 'https://example.com/a', title: undefined })).toEqual({
      url: 'https://example.com/a',
      title: null,
    });
    expect(trendSourceSchema.parse({ url: 'https://example.com/a', title: null })).toEqual({
      url: 'https://example.com/a',
      title: null,
    });
  });

  it('still keeps a real title, and still requires a usable url', () => {
    expect(trendSourceSchema.parse({ url: 'https://example.com/a', title: 'A headline' })).toEqual({
      url: 'https://example.com/a',
      title: 'A headline',
    });
    expect(() => trendSourceSchema.parse({ title: 'A headline' })).toThrow();
    expect(() => trendSourceSchema.parse({ url: 'not-a-url', title: null })).toThrow();
  });
});
