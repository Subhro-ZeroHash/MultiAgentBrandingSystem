import { describe, expect, it } from 'vitest';
import { bucketsNeedingRefresh } from './pool-scheduler.js';

const categoryBucket = { scope: 'category' as const, category: 'technology' as const };
const nationalBucket = { scope: 'national' as const, category: null };

describe('bucketsNeedingRefresh', () => {
  const now = new Date('2026-01-01T12:00:00Z');

  it('is due when the bucket has never run', () => {
    const due = bucketsNeedingRefresh([categoryBucket], new Map(), now);
    expect(due).toEqual([categoryBucket]);
  });

  it('is due when the latest run failed', () => {
    const latest = new Map([
      ['category:technology', { status: 'failed' as const, expiresAt: null }],
    ]);
    const due = bucketsNeedingRefresh([categoryBucket], latest, now);
    expect(due).toEqual([categoryBucket]);
  });

  it('is not due while a run is still queued or running', () => {
    const queued = new Map([
      ['category:technology', { status: 'queued' as const, expiresAt: null }],
    ]);
    const running = new Map([
      ['category:technology', { status: 'running' as const, expiresAt: null }],
    ]);
    expect(bucketsNeedingRefresh([categoryBucket], queued, now)).toEqual([]);
    expect(bucketsNeedingRefresh([categoryBucket], running, now)).toEqual([]);
  });

  it('is due when the latest succeeded run has expired', () => {
    const expired = new Map([
      [
        'category:technology',
        { status: 'succeeded' as const, expiresAt: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);
    expect(bucketsNeedingRefresh([categoryBucket], expired, now)).toEqual([categoryBucket]);
  });

  it('is not due when the latest succeeded run is still fresh', () => {
    const fresh = new Map([
      [
        'category:technology',
        { status: 'succeeded' as const, expiresAt: new Date('2026-01-02T00:00:00Z') },
      ],
    ]);
    expect(bucketsNeedingRefresh([categoryBucket], fresh, now)).toEqual([]);
  });

  it('keys the national bucket separately from any category bucket', () => {
    const latest = new Map([
      [
        'category:technology',
        { status: 'succeeded' as const, expiresAt: new Date('2026-01-02T00:00:00Z') },
      ],
    ]);
    const due = bucketsNeedingRefresh([categoryBucket, nationalBucket], latest, now);
    expect(due).toEqual([nationalBucket]);
  });
});
