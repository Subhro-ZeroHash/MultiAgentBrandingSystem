import { describe, expect, it } from 'vitest';
import { engagementRate, latestPerMedia, percentChange, sumMetrics } from './social.service.js';

const sample = (
  igMediaId: string,
  fetchedAt: string,
  metrics: Partial<{
    likeCount: number | null;
    commentsCount: number | null;
    reach: number | null;
    saved: number | null;
  }> = {},
) => ({
  igMediaId,
  fetchedAt: new Date(fetchedAt),
  likeCount: metrics.likeCount ?? null,
  commentsCount: metrics.commentsCount ?? null,
  reach: metrics.reach ?? null,
  saved: metrics.saved ?? null,
});

describe('latestPerMedia', () => {
  it('keeps only the newest sample per media', () => {
    const rows = [
      sample('a', '2026-08-22T10:00:00Z', { likeCount: 30 }),
      sample('b', '2026-08-22T09:00:00Z', { likeCount: 5 }),
      sample('a', '2026-08-21T10:00:00Z', { likeCount: 10 }),
    ];
    const latest = latestPerMedia(rows);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.igMediaId === 'a')?.likeCount).toBe(30);
  });

  /** The bug this exists to prevent: post_insights keeps one row per sync, so
   *  summing every row multiplies a post's likes by how often it was swept. */
  it('does not let repeated syncs inflate a single post', () => {
    const rows = [
      sample('a', '2026-08-22T10:00:00Z', { likeCount: 100, reach: 500 }),
      sample('a', '2026-08-22T04:00:00Z', { likeCount: 100, reach: 500 }),
      sample('a', '2026-08-21T22:00:00Z', { likeCount: 100, reach: 500 }),
    ];
    expect(sumMetrics(latestPerMedia(rows))).toEqual({
      likes: 100,
      comments: 0,
      reach: 500,
      saved: null,
    });
  });
});

describe('sumMetrics', () => {
  it('totals likes and comments across posts', () => {
    const totals = sumMetrics([
      sample('a', '2026-08-22T10:00:00Z', { likeCount: 10, commentsCount: 2 }),
      sample('b', '2026-08-22T10:00:00Z', { likeCount: 5, commentsCount: 1 }),
    ]);
    expect(totals.likes).toBe(15);
    expect(totals.comments).toBe(3);
  });

  /** A missing manage_insights grant must not read as "reach was zero" — the
   *  two mean opposite things to anyone acting on the number. */
  it('leaves reach null when no post carried it, rather than zero', () => {
    const totals = sumMetrics([sample('a', '2026-08-22T10:00:00Z', { likeCount: 10 })]);
    expect(totals.reach).toBeNull();
    expect(totals.saved).toBeNull();
  });

  it('sums reach across only the posts that reported it', () => {
    const totals = sumMetrics([
      sample('a', '2026-08-22T10:00:00Z', { reach: 100 }),
      sample('b', '2026-08-22T10:00:00Z', {}),
      sample('c', '2026-08-22T10:00:00Z', { reach: 50 }),
    ]);
    expect(totals.reach).toBe(150);
  });
});

describe('engagementRate', () => {
  it('expresses interactions as a percentage of reach', () => {
    expect(engagementRate({ likes: 40, comments: 10, reach: 1000 })).toBe(5);
  });

  it('is null without reach rather than dividing by nothing', () => {
    expect(engagementRate({ likes: 40, comments: 10, reach: null })).toBeNull();
  });

  it('is null on zero reach rather than Infinity', () => {
    expect(engagementRate({ likes: 40, comments: 10, reach: 0 })).toBeNull();
  });
});

describe('percentChange', () => {
  it('reports a rise and a fall', () => {
    expect(percentChange(100, 150)).toBe(50);
    expect(percentChange(100, 80)).toBeCloseTo(-20);
  });

  /** "+100%" off a zero baseline reads as real growth when it only means the
   *  metric existed this window and not last. */
  it('is null against a zero or missing baseline', () => {
    expect(percentChange(0, 50)).toBeNull();
    expect(percentChange(null, 50)).toBeNull();
    expect(percentChange(100, null)).toBeNull();
  });
});
