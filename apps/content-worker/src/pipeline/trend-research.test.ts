import { describe, expect, it } from 'vitest';
import {
  buildTrendSearchQueries,
  clipOpportunityCounts,
  resolveOpportunitySignals,
} from './trend-research.js';

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

/**
 * SYNTHESIS_SCHEMA carries no `maxItems` — confirmed against the live Gemini
 * API that a schema this deeply nested is rejected outright once an array
 * bound co-occurs with the enum-heavy `suggestedRequest` object. Zod's own
 * `.max()` is the actual enforcement now, and `clipOpportunityCounts` is what
 * keeps a model that overshoots "up to 8" from hard-failing the whole run on
 * that validation instead of just losing the extras.
 */
describe('clipOpportunityCounts', () => {
  const opportunity = (n: number) => ({ title: `opportunity ${n}` });

  it('drops opportunities beyond the eighth', () => {
    const raw = { opportunities: Array.from({ length: 11 }, (_unused, i) => opportunity(i)) };
    const clipped = clipOpportunityCounts(raw) as { opportunities: unknown[] };
    expect(clipped.opportunities).toHaveLength(8);
  });

  it('leaves a within-bounds payload untouched', () => {
    const raw = { opportunities: [{ title: 'a' }] };
    expect(clipOpportunityCounts(raw)).toEqual(raw);
  });

  it('passes through anything that is not the expected shape rather than throwing', () => {
    expect(clipOpportunityCounts(null)).toBeNull();
    expect(clipOpportunityCounts('not an object')).toBe('not an object');
    expect(clipOpportunityCounts({ noOpportunitiesField: true })).toEqual({
      noOpportunitiesField: true,
    });
    expect(clipOpportunityCounts({ opportunities: 'not an array' })).toEqual({
      opportunities: 'not an array',
    });
  });
});

describe('resolveOpportunitySignals', () => {
  const signals = [
    {
      id: 'sig-0',
      source: 'tavily',
      signalType: 'news_mention' as const,
      title: 'A',
      snippet: '',
      strength: 100,
      sourceUrl: 'https://real.example/a',
      publishedAt: null,
    },
    {
      id: 'sig-1',
      source: 'serpapi',
      signalType: 'news_mention' as const,
      title: 'B',
      snippet: '',
      strength: 88,
      sourceUrl: 'https://real.example/b',
      publishedAt: null,
    },
  ];

  const baseDraft = {
    topic: 'World Cup',
    category: 'event_festival' as const,
    title: 'World Cup opportunity',
    summary: 'summary',
    recommendation: 'recommendation',
    contentType: 'post' as const,
    score: {
      brandRelevance: 80,
      audienceRelevance: 80,
      popularity: 80,
      freshness: 80,
      marketingPotential: 80,
    },
    suggestedRequest: {
      campaignType: 'festival' as const,
      styleTemplate: 'festive' as const,
      outputFormat: 'instagram_post' as const,
      headlineText: null,
      offerText: null,
      extraInstructions: null,
    },
  };

  it('resolves valid indexes to real signal ids', () => {
    const [resolved] = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [0, 1] }],
      signals,
    );
    expect(resolved?.signalIds).toEqual(['sig-0', 'sig-1']);
  });

  it('drops an out-of-range index rather than crashing', () => {
    const [resolved] = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [0, 99] }],
      signals,
    );
    expect(resolved?.signalIds).toEqual(['sig-0']);
  });

  it('dedupes a repeated index', () => {
    const [resolved] = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [0, 0, 1] }],
      signals,
    );
    expect(resolved?.signalIds).toEqual(['sig-0', 'sig-1']);
  });

  it('drops the whole opportunity when every index is invalid — no evidence, no opportunity', () => {
    const resolved = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [99] }],
      signals,
    );
    expect(resolved).toHaveLength(0);
  });

  it('derives sources mechanically from the resolved signals, not from the model', () => {
    const [resolved] = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [0, 1] }],
      signals,
    );
    expect(resolved?.sources).toEqual([
      { url: 'https://real.example/a', title: 'A' },
      { url: 'https://real.example/b', title: 'B' },
    ]);
  });

  it('dedupes sources sharing the same URL across two resolved signals', () => {
    const duplicateUrlSignal = { ...signals[1]!, id: 'sig-2', sourceUrl: signals[0]!.sourceUrl };
    const [resolved] = resolveOpportunitySignals(
      [{ ...baseDraft, signalIndexes: [0, 2] }],
      [...signals, duplicateUrlSignal],
    );
    expect(resolved?.sources).toHaveLength(1);
  });
});
