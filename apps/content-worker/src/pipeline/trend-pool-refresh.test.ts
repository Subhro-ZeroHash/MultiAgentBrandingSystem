import { describe, expect, it } from 'vitest';
import {
  buildTrendPoolQueries,
  calendarEventsToSignals,
  clipPoolItemCounts,
  resolvePoolItemSignals,
} from './trend-pool-refresh.js';
import type { VerifiedCalendarEvent } from './festival-calendar.js';

describe('buildTrendPoolQueries', () => {
  it('builds two category-scoped queries for a category bucket', () => {
    const queries = buildTrendPoolQueries({
      scope: 'category',
      category: 'fashion_apparel',
      market: 'IN',
    });
    expect(queries.map((q) => q.category)).toEqual(['industry_topic', 'social_trend']);
  });

  it('folds the category label into every category-scoped query', () => {
    const queries = buildTrendPoolQueries({
      scope: 'category',
      category: 'food_beverage',
      market: 'IN',
    });
    for (const { request } of queries) {
      expect(request.query).toContain('Food & Beverage');
    }
  });

  it('builds a single national query, industry-agnostic', () => {
    const queries = buildTrendPoolQueries({ scope: 'national', market: 'IN' });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.category).toBe('event_festival');
    expect(queries[0]?.request.query).not.toMatch(/Technology|Fashion|Food/);
  });

  /**
   * The national query used to ask search which festivals were coming up.
   * Search cannot answer that — no page is a calendar — so it returned
   * whatever sale listicle ranked best, which is where the Republic Day result
   * came from. `festival-calendar.ts` owns that question now, and this query
   * is left to what search is genuinely good at.
   */
  it('no longer asks search to enumerate upcoming festivals', () => {
    const query = buildTrendPoolQueries({ scope: 'national', market: 'IN' })[0]!.request.query;
    expect(query).not.toMatch(/upcoming festivals|public holidays|next 30 days/i);
  });

  it('never asserts a country via `locale` — geography lives in the query text', () => {
    const queries = [
      ...buildTrendPoolQueries({ scope: 'category', category: 'sports', market: 'IN' }),
      ...buildTrendPoolQueries({ scope: 'national', market: 'IN' }),
    ];
    for (const { request } of queries) {
      expect(request.locale).toBeUndefined();
    }
  });
});

/** Same clip-not-reject reasoning as trend-research.test.ts's
 *  `clipRelevanceCounts` tests. */
describe('clipPoolItemCounts', () => {
  const item = (n: number) => ({ title: `item ${n}` });

  it('drops items beyond the fifteenth by default', () => {
    const raw = { items: Array.from({ length: 20 }, (_unused, i) => item(i)) };
    const clipped = clipPoolItemCounts(raw) as { items: unknown[] };
    expect(clipped.items).toHaveLength(15);
  });

  /** The national bucket asks for fewer, because generating more was blowing
   *  Gemini's own server-side deadline once the calendar landed. The clip has
   *  to follow the ask, or the prompt and the parser disagree. */
  it('honours a lower limit when the caller sets one', () => {
    const raw = { items: Array.from({ length: 20 }, (_unused, i) => item(i)) };
    const clipped = clipPoolItemCounts(raw, 10) as { items: unknown[] };
    expect(clipped.items).toHaveLength(10);
  });

  it('leaves a within-bounds payload untouched', () => {
    const raw = { items: [{ title: 'a' }] };
    expect(clipPoolItemCounts(raw)).toEqual(raw);
  });

  it('passes through anything that is not the expected shape rather than throwing', () => {
    expect(clipPoolItemCounts(null)).toBeNull();
    expect(clipPoolItemCounts({ items: 'not an array' })).toEqual({ items: 'not an array' });
  });
});

describe('resolvePoolItemSignals', () => {
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
    score: { popularity: 80, freshness: 80, marketingPotential: 80 },
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
    const [resolved] = resolvePoolItemSignals([{ ...baseDraft, signalIndexes: [0, 1] }], signals);
    expect(resolved?.signalIds).toEqual(['sig-0', 'sig-1']);
  });

  it('drops an out-of-range index rather than crashing', () => {
    const [resolved] = resolvePoolItemSignals([{ ...baseDraft, signalIndexes: [0, 99] }], signals);
    expect(resolved?.signalIds).toEqual(['sig-0']);
  });

  it('drops the whole item when every index is invalid — no evidence, no item', () => {
    const resolved = resolvePoolItemSignals([{ ...baseDraft, signalIndexes: [99] }], signals);
    expect(resolved).toHaveLength(0);
  });

  it('dedupes sources sharing the same URL across two resolved signals', () => {
    const duplicateUrlSignal = { ...signals[1]!, id: 'sig-2', sourceUrl: signals[0]!.sourceUrl };
    const [resolved] = resolvePoolItemSignals(
      [{ ...baseDraft, signalIndexes: [0, 2] }],
      [...signals, duplicateUrlSignal],
    );
    expect(resolved?.sources).toHaveLength(1);
  });
});

/**
 * The bug this exists to prevent: every pool query was hardcoded to India, so
 * a brand in New York was researched against Indian festivals and Indian
 * industry news. Geography has to come from the bucket's market.
 */
describe('buildTrendPoolQueries across markets', () => {
  it("names the brand's own market, not a hardcoded one", () => {
    const us = buildTrendPoolQueries({ scope: 'national', market: 'US' });
    expect(us[0]!.request.query).toContain('the United States');
    expect(us[0]!.request.query).not.toContain('India');
  });

  it('scopes category queries to the market too', () => {
    const gb = buildTrendPoolQueries({ scope: 'category', category: 'sports', market: 'GB' });
    for (const { request } of gb) {
      expect(request.query).toContain('the United Kingdom');
      expect(request.query).not.toContain('India');
    }
  });

  /** An unmapped code still has to produce a usable query rather than
   *  throwing or silently falling back to the wrong country. */
  it('degrades to the bare code for an unmapped market', () => {
    const pt = buildTrendPoolQueries({ scope: 'national', market: 'PT' });
    expect(pt[0]!.request.query).toContain('PT');
    expect(pt[0]!.request.query).not.toContain('India');
  });

  /** Search engines rank evergreen pages highly; dating the query is what
   *  biases them toward live coverage. */
  it('dates the query so the engine returns current coverage', () => {
    const now = new Date();
    const month = new Intl.DateTimeFormat('en-IN', {
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }).format(now);
    const queries = buildTrendPoolQueries({ scope: 'national', market: 'IN' });
    expect(queries[0]!.request.query).toContain(month);
  });
});

/**
 * Calendar events reach synthesis as signals, so an observance can carry a
 * pool item even when no search result mentions it — the case the old
 * search-only national bucket could never produce.
 */
describe('calendarEventsToSignals', () => {
  const verified = (over: Partial<VerifiedCalendarEvent> = {}): VerifiedCalendarEvent => ({
    name: 'Raksha Bandhan',
    date: '2026-08-28',
    kind: 'religious',
    significance: 'Siblings exchange gifts and sweets.',
    audience: 'observed across northern and western India',
    daysAway: 4,
    results: [
      {
        url: 'https://a.example/rb',
        title: 'Raksha Bandhan 2026',
        snippet: '',
        publishedAt: '2026-08-20',
      },
      { url: 'https://b.example/rb', title: 'Gifting guide', snippet: '', publishedAt: null },
    ],
    ...over,
  });

  it('emits one signal per event, not one per corroborating page', () => {
    const signals = calendarEventsToSignals([verified()]);
    expect(signals).toHaveLength(1);
  });

  it('carries the event name and date into the title', () => {
    const [signal] = calendarEventsToSignals([verified()]);
    expect(signal!.title).toContain('Raksha Bandhan');
    expect(signal!.title).toContain('2026-08-28');
  });

  it('marks the source as the calendar, distinct from a search provider', () => {
    const [signal] = calendarEventsToSignals([verified()]);
    expect(signal!.source).toBe('calendar');
    expect(signal!.signalType).toBe('event_proximity');
  });

  /** Every signal must carry a source URL; the top corroborating page is it. */
  it('takes its source URL from the best corroborating page', () => {
    const [signal] = calendarEventsToSignals([verified()]);
    expect(signal!.sourceUrl).toBe('https://a.example/rb');
  });

  /** `publishedAt` means "when this evidence was written". Quietly putting a
   *  future event date in it would misreport every downstream recency check. */
  it("reports the page's own date, never the event's", () => {
    const [signal] = calendarEventsToSignals([verified()]);
    expect(signal!.publishedAt).toBe('2026-08-20');
  });

  it('scores a nearer event stronger than a distant one', () => {
    const [near] = calendarEventsToSignals([verified({ daysAway: 2 })]);
    const [far] = calendarEventsToSignals([verified({ daysAway: 40 })]);
    expect(near!.strength).toBeGreaterThan(far!.strength);
  });

  /** An event six weeks out is still a real planning opportunity, so strength
   *  is floored rather than decaying toward nothing. */
  it('keeps a distant event meaningfully strong', () => {
    const [far] = calendarEventsToSignals([verified({ daysAway: 45 })]);
    expect(far!.strength).toBeGreaterThanOrEqual(40);
  });

  it('skips an event with no corroborating page rather than emitting a sourceless signal', () => {
    expect(calendarEventsToSignals([verified({ results: [] })])).toHaveLength(0);
  });

  it('contributes nothing for a bucket with no calendar', () => {
    expect(calendarEventsToSignals([])).toHaveLength(0);
  });
});
