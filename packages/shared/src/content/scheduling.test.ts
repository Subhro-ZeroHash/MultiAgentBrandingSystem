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

  it('skips a slot already past rather than clamping it to now', () => {
    const now = new Date('2026-08-01T14:00:00Z'); // inside the 09:00-21:00 window
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 1,
      postsPerDay: 3, // natural slots: 09:00, 15:00, 21:00
      now,
    });

    // Still three posts, and all three keep a natural window time — the 09:00
    // slot is dropped and the count is made up on the following day.
    expect(slots).toHaveLength(3);
    expect(slots[0]!.toISOString()).toBe('2026-08-01T15:00:00.000Z');
    expect(slots[1]!.toISOString()).toBe('2026-08-01T21:00:00.000Z');
    expect(slots[2]!.toISOString()).toBe('2026-08-02T09:00:00.000Z');
  });

  /**
   * The regression this function was rewritten for. A campaign created in the
   * evening used to compress that day's stale slots into consecutive minutes;
   * generation alone takes longer than the gap, so those posts could not be
   * reviewed in time and expired instead of publishing.
   */
  it('never schedules posts closer together than the daily cadence', () => {
    const now = new Date('2026-08-01T20:00:00Z'); // most of today's window gone
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 2,
      postsPerDay: 5,
      now,
    });

    expect(slots).toHaveLength(10);
    for (let i = 1; i < slots.length; i++) {
      const gapMinutes = (slots[i]!.getTime() - slots[i - 1]!.getTime()) / 60_000;
      expect(
        gapMinutes,
        `slots ${i - 1}->${i} are only ${gapMinutes}m apart`,
      ).toBeGreaterThanOrEqual(180);
    }
  });

  it('leaves enough lead time on the first slot to generate and review', () => {
    const now = new Date('2026-08-01T14:50:00Z'); // 10 minutes before the 15:00 slot
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 1,
      postsPerDay: 3,
      now,
    });

    // 15:00 is too soon to generate and approve, so it is skipped too.
    expect(slots[0]!.toISOString()).toBe('2026-08-01T21:00:00.000Z');
    for (const slot of slots) {
      expect(slot.getTime() - now.getTime()).toBeGreaterThanOrEqual(45 * 60_000);
    }
  });

  it('still returns the requested count when startAt is in the past', () => {
    const slots = computeScheduleSlots({
      startAt: new Date('2026-08-01T00:00:00Z'),
      totalDays: 2,
      postsPerDay: 3,
      now: new Date('2026-08-05T00:00:00Z'), // four days after startAt
    });

    expect(slots).toHaveLength(6);
    for (const slot of slots) {
      expect(slot.getTime()).toBeGreaterThan(new Date('2026-08-05T00:00:00Z').getTime());
    }
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
