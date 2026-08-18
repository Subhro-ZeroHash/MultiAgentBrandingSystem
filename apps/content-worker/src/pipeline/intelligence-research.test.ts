import { describe, expect, it } from 'vitest';
import {
  clipCompetitorItemCounts,
  clipIntelligenceRelevanceCounts,
  resolveIntelligenceRelevanceDrafts,
  verifyCompetitorSources,
} from './intelligence-research.js';

const poolItem = (n: number) => ({
  id: `pool-item-${n}`,
  runId: 'run-1',
  category: 'industry_news' as const,
  title: `title ${n}`,
  summary: 'summary',
  urgency: 'medium' as const,
  score: { businessImpact: 70, recency: 70 },
  sources: [],
  createdAt: new Date(),
});

const baseDraft = {
  brandRelevance: 90,
  industryRelevance: 80,
  geographicRelevance: 60,
  whyItMatters: 'It affects this brand directly.',
};

describe('clipIntelligenceRelevanceCounts', () => {
  it('drops items beyond the tenth', () => {
    const raw = { items: Array.from({ length: 14 }, (_unused, i) => ({ poolItemIndex: i })) };
    const clipped = clipIntelligenceRelevanceCounts(raw) as { items: unknown[] };
    expect(clipped.items).toHaveLength(10);
  });

  it('leaves a within-bounds payload untouched', () => {
    const raw = { items: [{ poolItemIndex: 0 }] };
    expect(clipIntelligenceRelevanceCounts(raw)).toEqual(raw);
  });
});

describe('resolveIntelligenceRelevanceDrafts', () => {
  const poolItems = [poolItem(0), poolItem(1)];

  it('resolves a valid index to the matching pool item', () => {
    const [resolved] = resolveIntelligenceRelevanceDrafts(
      [{ ...baseDraft, poolItemIndex: 1 }],
      poolItems,
    );
    expect(resolved?.poolItem.id).toBe('pool-item-1');
  });

  it('drops an out-of-range index rather than crashing', () => {
    const resolved = resolveIntelligenceRelevanceDrafts(
      [{ ...baseDraft, poolItemIndex: 99 }],
      poolItems,
    );
    expect(resolved).toHaveLength(0);
  });

  it('dedupes a repeated index, keeping only the first occurrence', () => {
    const resolved = resolveIntelligenceRelevanceDrafts(
      [
        { ...baseDraft, poolItemIndex: 0, brandRelevance: 10 },
        { ...baseDraft, poolItemIndex: 0, brandRelevance: 99 },
      ],
      poolItems,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.draft.brandRelevance).toBe(10);
  });
});

describe('clipCompetitorItemCounts', () => {
  it('drops items beyond the tenth and clips each to 5 sources', () => {
    const raw = {
      items: Array.from({ length: 12 }, (_unused, i) => ({
        title: `item ${i}`,
        sources: Array.from({ length: 8 }, (_u, j) => ({ url: `u${j}` })),
      })),
    };
    const clipped = clipCompetitorItemCounts(raw) as { items: Array<{ sources: unknown[] }> };
    expect(clipped.items).toHaveLength(10);
    expect(clipped.items[0]?.sources).toHaveLength(5);
  });
});

describe('verifyCompetitorSources', () => {
  const signal = {
    provider: 'tavily',
    results: [{ url: 'https://real.example/a', title: 'A', snippet: '', publishedAt: null }],
  };

  it('keeps a source whose URL actually appears in the search results', () => {
    const kept = verifyCompetitorSources([{ url: 'https://real.example/a', title: 'A' }], [signal]);
    expect(kept).toHaveLength(1);
  });

  it('drops a fabricated source URL', () => {
    const kept = verifyCompetitorSources([{ url: 'https://fake.example/z', title: 'Z' }], [signal]);
    expect(kept).toHaveLength(0);
  });

  it('keeps a source that appears in any provider result', () => {
    const serpSignal = {
      provider: 'serpapi',
      results: [{ url: 'https://serp.example/b', title: 'B', snippet: '', publishedAt: null }],
    };
    const kept = verifyCompetitorSources(
      [{ url: 'https://serp.example/b', title: 'B' }],
      [signal, serpSignal],
    );
    expect(kept).toHaveLength(1);
  });
});
