import { describe, expect, it } from 'vitest';
import { buildTrendSearchQueries, clipSynthesisCounts, verifySources } from './trend-research.js';

describe('buildTrendSearchQueries', () => {
  it('builds one query per category', () => {
    const queries = buildTrendSearchQueries({
      brand: { category: 'Saree boutique', location: 'Jaipur' },
      locationOverride: null,
      focus: null,
    });
    expect(queries.map((q) => q.category)).toEqual([
      'industry_topic',
      'event_festival',
      'social_trend',
    ]);
  });

  it('folds the brand location and industry into the query text', () => {
    const [industry] = buildTrendSearchQueries({
      brand: { category: 'Saree boutique', location: 'Jaipur' },
      locationOverride: null,
      focus: null,
    });
    expect(industry?.request.query).toContain('Saree boutique');
    expect(industry?.request.query).toContain('Jaipur');
  });

  it('prefers a run-level location override to the Brand Kit location', () => {
    const [industry] = buildTrendSearchQueries({
      brand: { category: 'Saree boutique', location: 'Jaipur' },
      locationOverride: 'Mumbai',
      focus: null,
    });
    expect(industry?.request.query).toContain('Mumbai');
    expect(industry?.request.query).not.toContain('Jaipur');
  });

  it('folds a focus line into every query, not just one', () => {
    const queries = buildTrendSearchQueries({
      brand: { category: 'Cafe', location: 'Pune' },
      locationOverride: null,
      focus: 'new menu launch',
    });
    for (const { request } of queries) {
      expect(request.query.toLowerCase()).toContain('new menu launch');
    }
  });

  it('falls back to "small business" when the brand has no category', () => {
    const [industry] = buildTrendSearchQueries({
      brand: { category: null, location: null },
      locationOverride: null,
      focus: null,
    });
    expect(industry?.request.query).toContain('small business');
  });

  it('never asserts a country via `locale` — geography lives in the query text', () => {
    // brand.location is a city ("Jaipur"), and Tavily's country filter wants a
    // country; mapping one to the other would need geocoding this MVP does not
    // have, so `locale` stays unset rather than passing a wrong value through.
    const queries = buildTrendSearchQueries({
      brand: { category: 'Cafe', location: 'Jaipur' },
      locationOverride: null,
      focus: null,
    });
    for (const { request } of queries) {
      expect(request.locale).toBeUndefined();
    }
  });

  it('asks the events query for a wider recency window than the others', () => {
    // Festivals and launches are dated weeks out; treating them with the same
    // 14-day window as breaking news would miss most of them.
    const queries = buildTrendSearchQueries({
      brand: { category: 'Cafe', location: null },
      locationOverride: null,
      focus: null,
    });
    const events = queries.find((q) => q.category === 'event_festival');
    const industry = queries.find((q) => q.category === 'industry_topic');
    expect(events?.request.recencyDays ?? 0).toBeGreaterThan(industry?.request.recencyDays ?? 0);
  });
});

describe('verifySources', () => {
  const signals = [
    {
      category: 'industry_topic' as const,
      request: { query: 'x' },
      results: [
        { url: 'https://real.example/a', title: 'A', snippet: '', publishedAt: null },
        { url: 'https://real.example/b', title: 'B', snippet: '', publishedAt: null },
      ],
    },
    {
      category: 'event_festival' as const,
      request: { query: 'y' },
      results: [{ url: 'https://real.example/c', title: 'C', snippet: '', publishedAt: null }],
    },
  ];

  it('keeps a citation that matches a real search result', () => {
    const kept = verifySources([{ url: 'https://real.example/a', title: 'A' }], signals);
    expect(kept).toHaveLength(1);
  });

  it('drops a citation the model fabricated', () => {
    // The failure mode this guards: a model asked to cite is not a model that
    // reliably cites correctly, and a fabricated link must never reach the
    // user disguised as a real source.
    const kept = verifySources(
      [{ url: 'https://not-in-any-search-result.example/fake', title: 'Made up' }],
      signals,
    );
    expect(kept).toHaveLength(0);
  });

  it('checks across every search category, not just the first', () => {
    const kept = verifySources([{ url: 'https://real.example/c', title: 'C' }], signals);
    expect(kept).toHaveLength(1);
  });

  it('keeps only the real ones out of a mixed list', () => {
    const kept = verifySources(
      [
        { url: 'https://real.example/a', title: 'A' },
        { url: 'https://fake.example/z', title: 'Fake' },
        { url: 'https://real.example/c', title: 'C' },
      ],
      signals,
    );
    expect(kept.map((s) => s.url)).toEqual(['https://real.example/a', 'https://real.example/c']);
  });

  it('returns an empty list rather than throwing when nothing survives', () => {
    expect(verifySources([], signals)).toEqual([]);
  });
});

/**
 * SYNTHESIS_SCHEMA carries no `maxItems` — confirmed against the live Gemini
 * API that a schema this deeply nested is rejected outright once an array
 * bound co-occurs with the enum-heavy `suggestedRequest` object. Zod's own
 * `.max()` is the actual enforcement now, and `clipSynthesisCounts` is what
 * keeps a model that overshoots "up to 8" from hard-failing the whole run on
 * that validation instead of just losing the extras.
 */
describe('clipSynthesisCounts', () => {
  const idea = (n: number) => ({ title: `idea ${n}` });

  it('drops ideas beyond the eighth', () => {
    const raw = { ideas: Array.from({ length: 11 }, (_unused, i) => idea(i)) };
    const clipped = clipSynthesisCounts(raw) as { ideas: unknown[] };
    expect(clipped.ideas).toHaveLength(8);
  });

  it('drops sources beyond the fifth, per idea', () => {
    const raw = {
      ideas: [{ title: 'a', sources: Array.from({ length: 9 }, (_unused, i) => ({ url: `u${i}` })) }],
    };
    const clipped = clipSynthesisCounts(raw) as { ideas: Array<{ sources: unknown[] }> };
    expect(clipped.ideas[0]?.sources).toHaveLength(5);
  });

  it('leaves a within-bounds payload untouched', () => {
    const raw = { ideas: [{ title: 'a', sources: [{ url: 'u1' }] }] };
    expect(clipSynthesisCounts(raw)).toEqual(raw);
  });

  it('passes through anything that is not the expected shape rather than throwing', () => {
    expect(clipSynthesisCounts(null)).toBeNull();
    expect(clipSynthesisCounts('not an object')).toBe('not an object');
    expect(clipSynthesisCounts({ noIdeasField: true })).toEqual({ noIdeasField: true });
    expect(clipSynthesisCounts({ ideas: 'not an array' })).toEqual({ ideas: 'not an array' });
  });

  it('leaves an idea missing a sources array alone rather than injecting one', () => {
    const raw = { ideas: [{ title: 'a' }] };
    expect(clipSynthesisCounts(raw)).toEqual(raw);
  });
});
