import { describe, expect, it } from 'vitest';
import { nextResearchAt, TREND_FREQUENCY_HOURS } from './brand-context.js';

/**
 * `nextResearchAt` is the only definition of when the autonomous loop wakes up
 * for a brand. Two consumers depend on it agreeing with itself: the scheduler
 * queries `next_research_at <= now`, and the settings screen renders the same
 * column as "next research in...". A regression here is invisible in both —
 * the screen shows a plausible time and the brand simply never gets picked up.
 */
describe('nextResearchAt', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('is due immediately for a brand that has never been researched', () => {
    // Switching automation on and being told to wait until tomorrow reads as
    // a broken feature, so a null last-run means "now", not "now + cadence".
    expect(nextResearchAt('weekly', null, now)).toEqual(now);
  });

  it('adds the cadence to the last run', () => {
    const lastRun = new Date('2026-08-03T06:00:00.000Z');
    expect(nextResearchAt('daily', lastRun, now)).toEqual(
      new Date(lastRun.getTime() + TREND_FREQUENCY_HOURS.daily * 3_600_000),
    );
  });

  it('never returns a time in the past', () => {
    // A brand paused for a fortnight, or one whose cadence was shortened while
    // it sat idle, would otherwise get a timestamp days behind — which the
    // scheduler treats identically to "now" but the settings screen renders as
    // "due 3 days ago".
    const staleRun = new Date('2026-07-01T00:00:00.000Z');
    expect(nextResearchAt('daily', staleRun, now)).toEqual(now);
  });

  it('spaces the three cadences apart, longest last', () => {
    const lastRun = new Date('2026-08-03T11:00:00.000Z');
    const daily = nextResearchAt('daily', lastRun, now).getTime();
    const threeDays = nextResearchAt('three_days', lastRun, now).getTime();
    const weekly = nextResearchAt('weekly', lastRun, now).getTime();

    expect(daily).toBeLessThan(threeDays);
    expect(threeDays).toBeLessThan(weekly);
  });
});
