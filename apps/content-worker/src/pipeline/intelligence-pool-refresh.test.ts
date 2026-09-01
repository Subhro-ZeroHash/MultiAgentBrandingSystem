import { describe, expect, it } from 'vitest';
import {
  buildIntelligencePoolQueries,
  clipIntelligencePoolCounts,
  verifyPoolSources,
} from './intelligence-pool-refresh.js';

describe('buildIntelligencePoolQueries', () => {
  it('builds government_policy and industry_news for a category bucket', () => {
    const queries = buildIntelligencePoolQueries({
      scope: 'category',
      category: 'finance',
      market: 'IN',
    });
    expect(queries.map((q) => q.category)).toEqual(['government_policy', 'industry_news']);
  });

  it('folds the category label into every category-scoped query', () => {
    const queries = buildIntelligencePoolQueries({
      scope: 'category',
      category: 'technology',
      market: 'IN',
    });
    for (const { request } of queries) {
      expect(request.query).toContain('Technology');
    }
  });

  it('builds a single national `local` query for the national bucket', () => {
    const queries = buildIntelligencePoolQueries({ scope: 'national', market: 'IN' });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.category).toBe('local');
  });

  it('never leaves competitor in the poolable set', () => {
    const queries = [
      ...buildIntelligencePoolQueries({ scope: 'category', category: 'sports', market: 'IN' }),
      ...buildIntelligencePoolQueries({ scope: 'national', market: 'IN' }),
    ];
    expect(queries.map((q) => q.category)).not.toContain('competitor');
  });
});

describe('clipIntelligencePoolCounts', () => {
  it('drops items beyond the fifteenth', () => {
    const raw = { items: Array.from({ length: 20 }, (_unused, i) => ({ title: `item ${i}` })) };
    const clipped = clipIntelligencePoolCounts(raw) as { items: unknown[] };
    expect(clipped.items).toHaveLength(15);
  });

  it('clips each item to 5 sources', () => {
    const raw = {
      items: [
        { title: 'a', sources: Array.from({ length: 8 }, (_unused, i) => ({ url: `u${i}` })) },
      ],
    };
    const clipped = clipIntelligencePoolCounts(raw) as { items: Array<{ sources: unknown[] }> };
    expect(clipped.items[0]?.sources).toHaveLength(5);
  });

  it('passes through anything that is not the expected shape rather than throwing', () => {
    expect(clipIntelligencePoolCounts(null)).toBeNull();
    expect(clipIntelligencePoolCounts({ items: 'not an array' })).toEqual({
      items: 'not an array',
    });
  });
});

describe('verifyPoolSources', () => {
  const signals = [
    {
      category: 'local' as const,
      request: { query: 'x' },
      results: [{ url: 'https://real.example/a', title: 'A', snippet: '', publishedAt: null }],
    },
  ];

  it('keeps a source whose URL actually appears in the search results', () => {
    const kept = verifyPoolSources([{ url: 'https://real.example/a', title: 'A' }], signals);
    expect(kept).toHaveLength(1);
  });

  it('drops a fabricated source URL', () => {
    const kept = verifyPoolSources([{ url: 'https://fake.example/z', title: 'Z' }], signals);
    expect(kept).toHaveLength(0);
  });
});
