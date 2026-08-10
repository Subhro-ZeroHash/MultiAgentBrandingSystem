import { describe, expect, it } from 'vitest';
import { clipRelevanceCounts, resolveRelevanceDrafts } from './trend-research.js';

const poolItem = (n: number) => ({
  id: `pool-item-${n}`,
  runId: 'run-1',
  topic: `topic ${n}`,
  category: 'event_festival' as const,
  title: `title ${n}`,
  summary: 'summary',
  recommendation: 'recommendation',
  contentType: 'post' as const,
  score: { popularity: 80, freshness: 80, marketingPotential: 80 },
  signalCount: 2,
  sources: [],
  suggestedRequest: {
    campaignType: 'festival' as const,
    styleTemplate: 'festive' as const,
    outputFormat: 'instagram_post' as const,
    headlineText: null,
    offerText: null,
    extraInstructions: null,
  },
  createdAt: new Date(),
});

const baseDraft = {
  brandRelevance: 90,
  audienceRelevance: 85,
  recommendationOverride: null,
};

/**
 * Same "clip rather than reject an overshoot" reasoning trend-pool-refresh's
 * own `clipPoolItemCounts` tests pin — see that function's comment.
 */
describe('clipRelevanceCounts', () => {
  it('drops items beyond the eighth', () => {
    const raw = { items: Array.from({ length: 11 }, (_unused, i) => ({ poolItemIndex: i })) };
    const clipped = clipRelevanceCounts(raw) as { items: unknown[] };
    expect(clipped.items).toHaveLength(8);
  });

  it('leaves a within-bounds payload untouched', () => {
    const raw = { items: [{ poolItemIndex: 0 }] };
    expect(clipRelevanceCounts(raw)).toEqual(raw);
  });

  it('passes through anything that is not the expected shape rather than throwing', () => {
    expect(clipRelevanceCounts(null)).toBeNull();
    expect(clipRelevanceCounts('not an object')).toBe('not an object');
    expect(clipRelevanceCounts({ noItemsField: true })).toEqual({ noItemsField: true });
    expect(clipRelevanceCounts({ items: 'not an array' })).toEqual({ items: 'not an array' });
  });
});

describe('resolveRelevanceDrafts', () => {
  const poolItems = [poolItem(0), poolItem(1)];

  it('resolves a valid index to the matching pool item', () => {
    const [resolved] = resolveRelevanceDrafts([{ ...baseDraft, poolItemIndex: 1 }], poolItems);
    expect(resolved?.poolItem.id).toBe('pool-item-1');
    expect(resolved?.draft.brandRelevance).toBe(90);
  });

  it('drops an out-of-range index rather than crashing', () => {
    const resolved = resolveRelevanceDrafts([{ ...baseDraft, poolItemIndex: 99 }], poolItems);
    expect(resolved).toHaveLength(0);
  });

  it('drops a negative index rather than crashing', () => {
    const resolved = resolveRelevanceDrafts([{ ...baseDraft, poolItemIndex: -1 }], poolItems);
    expect(resolved).toHaveLength(0);
  });

  it('dedupes a repeated index, keeping only the first occurrence', () => {
    const resolved = resolveRelevanceDrafts(
      [
        { ...baseDraft, poolItemIndex: 0, brandRelevance: 10 },
        { ...baseDraft, poolItemIndex: 0, brandRelevance: 99 },
      ],
      poolItems,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.draft.brandRelevance).toBe(10);
  });

  it('resolves every distinct valid index in one pass', () => {
    const resolved = resolveRelevanceDrafts(
      [
        { ...baseDraft, poolItemIndex: 0 },
        { ...baseDraft, poolItemIndex: 1 },
      ],
      poolItems,
    );
    expect(resolved.map((r) => r.poolItem.id)).toEqual(['pool-item-0', 'pool-item-1']);
  });
});
