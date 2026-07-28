import { describe, expect, it } from 'vitest';
import { computeScheduleSlots } from './scheduling.js';

/** A fixed "now" well before any window in these tests opens, so nothing gets
 *  bumped unless a test deliberately puts `now` inside the window. */
const FAR_PAST_NOW = new Date('2020-01-01T00:00:00Z');

describe('computeScheduleSlots', () => {
  it('spreads posts evenly across the default window, one day at a time', () => {
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 2,
      postsPerDay: 3,
      now: FAR_PAST_NOW,
    });

    expect(slots).toHaveLength(6);
    // Day 1: 09:00, 15:00, 21:00 UTC (evenly spaced across the 09:00-21:00 window).
    expect(slots[0]!.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(slots[1]!.toISOString()).toBe('2026-08-01T15:00:00.000Z');
    expect(slots[2]!.toISOString()).toBe('2026-08-01T21:00:00.000Z');
    // Day 2 repeats the same times on the next calendar date.
    expect(slots[3]!.toISOString()).toBe('2026-08-02T09:00:00.000Z');
    expect(slots[5]!.toISOString()).toBe('2026-08-02T21:00:00.000Z');
  });

  it('puts a single daily post at the window midpoint, not the window open', () => {
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 1,
      postsPerDay: 1,
      now: FAR_PAST_NOW,
    });

    expect(slots).toEqual([new Date('2026-08-01T15:00:00.000Z')]);
  });

  it('returns slots in chronological order', () => {
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 3,
      postsPerDay: 5,
      now: FAR_PAST_NOW,
    });

    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.getTime()).toBeGreaterThan(slots[i - 1]!.getTime());
    }
  });

  it('bumps a slot that would land in the past up to now + 5 minutes', () => {
    const now = new Date('2026-08-01T14:00:00Z'); // inside the 09:00-21:00 window
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 1,
      postsPerDay: 3, // natural slots: 09:00, 15:00, 21:00
      now,
    });

    // The 09:00 slot is already in the past relative to `now` -> bumped forward.
    expect(slots[0]!.getTime()).toBe(now.getTime() + 5 * 60_000);
    // The 15:00 and 21:00 slots are still in the future and keep their natural times.
    expect(slots[1]!.toISOString()).toBe('2026-08-01T15:00:00.000Z');
    expect(slots[2]!.toISOString()).toBe('2026-08-01T21:00:00.000Z');
  });

  it('keeps a bumped slot strictly before the next one', () => {
    // Every slot lands in the past relative to `now`, so all three would
    // naively bump to the exact same timestamp without the monotonic guard.
    const now = new Date('2026-08-05T00:00:00Z');
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 1,
      postsPerDay: 3,
      now,
    });

    expect(slots[0]!.getTime()).toBeLessThan(slots[1]!.getTime());
    expect(slots[1]!.getTime()).toBeLessThan(slots[2]!.getTime());
  });

  it('rejects invalid inputs', () => {
    const base = { startAt: new Date(), now: FAR_PAST_NOW };
    expect(() => computeScheduleSlots({ ...base, totalDays: 0, postsPerDay: 1 })).toThrow();
    expect(() => computeScheduleSlots({ ...base, totalDays: 1, postsPerDay: 0 })).toThrow();
    expect(() =>
      computeScheduleSlots({
        ...base,
        totalDays: 1,
        postsPerDay: 1,
        windowStartHour: 20,
        windowEndHour: 9,
      }),
    ).toThrow();
  });
});
