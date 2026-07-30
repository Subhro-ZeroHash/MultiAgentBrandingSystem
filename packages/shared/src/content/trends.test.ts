import { describe, expect, it } from 'vitest';
import { computeTrendScore, TREND_SCORE_WEIGHTS } from './trends.js';

/**
 * `computeTrendScore` is the single definition of the number ideas are ranked
 * by — the model is deliberately never asked for it directly, because a
 * self-reported composite can disagree with its own sub-scores (the same
 * reasoning `computeGeoScore` in geo/visibility.ts documents for the GEO
 * headline number). A silent regression here would misrank every research run
 * without producing a single wrong-looking sub-score to notice it by.
 */
describe('computeTrendScore', () => {
  it('weights the axes as documented, not equally', () => {
    // Perfect brand fit, mediocre everything else, vs. the reverse: brand fit
    // should win, because TREND_SCORE_WEIGHTS.brandRelevance is the largest
    // single weight.
    const brandFocused = computeTrendScore({
      brandRelevance: 100,
      audienceRelevance: 50,
      popularity: 50,
      freshness: 50,
      marketingPotential: 50,
    });
    const popularityFocused = computeTrendScore({
      brandRelevance: 50,
      audienceRelevance: 50,
      popularity: 100,
      freshness: 50,
      marketingPotential: 50,
    });
    expect(brandFocused).toBeGreaterThan(popularityFocused);
  });

  it('scores a uniform input at that same value, up to rounding', () => {
    const score = computeTrendScore({
      brandRelevance: 80,
      audienceRelevance: 80,
      popularity: 80,
      freshness: 80,
      marketingPotential: 80,
    });
    expect(score).toBe(80);
  });

  it('is 0 for an all-zero input and 100 for an all-100 input', () => {
    const zero = { brandRelevance: 0, audienceRelevance: 0, popularity: 0, freshness: 0, marketingPotential: 0 };
    const hundred = { brandRelevance: 100, audienceRelevance: 100, popularity: 100, freshness: 100, marketingPotential: 100 };
    expect(computeTrendScore(zero)).toBe(0);
    expect(computeTrendScore(hundred)).toBe(100);
  });

  it('sums the documented weights to exactly 1', () => {
    // A drifted weight set would silently over- or under-scale every score —
    // worth pinning as a standalone fact about the constant, not just about
    // computeTrendScore's output.
    const total = Object.values(TREND_SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('rewards a niche-but-relevant trend over a huge-but-irrelevant one', () => {
    // The scenario the weighting exists for: an SMB gets more value from
    // "perfectly on-brand, modest reach" than "huge, generic".
    const nicheButRelevant = computeTrendScore({
      brandRelevance: 90,
      audienceRelevance: 85,
      popularity: 20,
      freshness: 70,
      marketingPotential: 80,
    });
    const hugeButGeneric = computeTrendScore({
      brandRelevance: 15,
      audienceRelevance: 10,
      popularity: 95,
      freshness: 90,
      marketingPotential: 30,
    });
    expect(nicheButRelevant).toBeGreaterThan(hugeButGeneric);
  });
});
