import { describe, expect, it } from 'vitest';
import {
  buildBrandIntelligenceQueries,
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

describe('buildBrandIntelligenceQueries', () => {
  const bata = {
    brandName: 'Bata',
    industry: 'foot wear',
    location: 'India',
    competitors: [] as string[],
  };

  /** brand_news was in the taxonomy but excluded from the poolable set and
   *  never searched per-brand, so the category could not produce an item
   *  under any circumstances. */
  it('searches for the brand itself, which nothing did before', () => {
    const brandNews = buildBrandIntelligenceQueries(bata).find((q) => q.category === 'brand_news');
    expect(brandNews).toBeDefined();
    expect(brandNews!.request.query).toContain('Bata');
  });

  /** The apparel-not-footwear problem: pooled queries ask about the brand's
   *  taxonomy bucket ("Fashion & Apparel"), never its real industry text. */
  it("uses the brand's own industry words, not a taxonomy label", () => {
    const industry = buildBrandIntelligenceQueries(bata).find(
      (q) => q.category === 'industry_news',
    );
    expect(industry!.request.query).toContain('foot wear');
    expect(industry!.request.query).toContain('India');
    expect(industry!.request.query).not.toMatch(/fashion|apparel/i);
  });

  /** Competitor search used to be skipped entirely when no competitors were
   *  named — the default state — so the category was always empty. */
  it('still searches competitors when none are named', () => {
    const competitor = buildBrandIntelligenceQueries(bata).find(
      (q) => q.category === 'competitor',
    );
    expect(competitor).toBeDefined();
    expect(competitor!.request.query).toMatch(/competitors of Bata/i);
  });

  it('prefers named competitors over discovery when they exist', () => {
    const q = buildBrandIntelligenceQueries({
      ...bata,
      competitors: ['Liberty', 'Relaxo'],
    }).find((x) => x.category === 'competitor');
    expect(q!.request.query).toContain('Liberty');
    expect(q!.request.query).not.toMatch(/competitors of/i);
  });

  /** Without industry text the niche query collapses into the pooled query it
   *  exists to improve on, so it is skipped rather than sent as noise. */
  it('omits the niche query when the brand has no industry text', () => {
    const categories = buildBrandIntelligenceQueries({ ...bata, industry: null }).map(
      (q) => q.category,
    );
    expect(categories).not.toContain('industry_news');
    expect(categories).toContain('brand_news');
  });

  it('every query is date-bounded so results are current', () => {
    for (const { request } of buildBrandIntelligenceQueries(bata)) {
      expect(request.recencyDays).toBeGreaterThan(0);
    }
  });
});
