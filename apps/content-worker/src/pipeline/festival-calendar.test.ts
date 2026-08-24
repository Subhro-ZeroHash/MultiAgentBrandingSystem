import { describe, expect, it } from 'vitest';
import type { WebSearchResult } from '@bmas/ai';
import {
  CALENDAR_HORIZON_DAYS,
  MAX_CALENDAR_EVENTS,
  buildCalendarVerificationQuery,
  daysBetween,
  describeCalendarForPrompt,
  filterToHorizon,
  keepCorroborated,
  type CalendarEvent,
} from './festival-calendar.js';

const event = (name: string, date: string): CalendarEvent => ({
  name,
  date,
  kind: 'religious',
  significance: 'People exchange gifts.',
  audience: 'observed nationwide',
});

const result = (url: string): WebSearchResult => ({
  url,
  title: 'A page',
  snippet: '',
  publishedAt: null,
});

describe('daysBetween', () => {
  it('counts whole calendar days forward', () => {
    expect(daysBetween('2026-08-24', '2026-08-28')).toBe(4);
  });

  it('is negative for a date already past', () => {
    expect(daysBetween('2026-08-24', '2026-01-26')).toBeLessThan(0);
  });

  /** Both sides are parsed at UTC midnight, so a month or DST boundary must
   *  not shift the count by a day. */
  it('is unaffected by month and DST boundaries', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });

  it('is NaN for an unparseable date rather than a wrong number', () => {
    expect(daysBetween('2026-08-24', 'next Tuesday')).toBeNaN();
  });
});

describe('filterToHorizon', () => {
  const today = '2026-08-24';

  /**
   * The Republic Day complaint, reduced to its mechanism. Asked for the next
   * six weeks, a model volunteers the year's *famous* festivals — so the
   * window has to be enforced here rather than trusted to the prompt.
   */
  it('drops an event whose date has already passed', () => {
    const kept = filterToHorizon([event('Republic Day', '2026-01-26')], today);
    expect(kept).toHaveLength(0);
  });

  it('keeps an event inside the window', () => {
    const kept = filterToHorizon([event('Raksha Bandhan', '2026-08-28')], today);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.daysAway).toBe(4);
  });

  /** A festival is still an opportunity on the day itself. */
  it('counts today as upcoming', () => {
    const kept = filterToHorizon([event('Today Festival', today)], today);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.daysAway).toBe(0);
  });

  it('drops an event beyond the horizon', () => {
    const beyond = new Date(
      Date.parse(`${today}T00:00:00Z`) + (CALENDAR_HORIZON_DAYS + 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    expect(filterToHorizon([event('Too Far', beyond)], today)).toHaveLength(0);
  });

  it('includes the last day of the horizon', () => {
    const edge = new Date(Date.parse(`${today}T00:00:00Z`) + CALENDAR_HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(filterToHorizon([event('Edge', edge)], today)).toHaveLength(1);
  });

  it('orders by how soon, so the nearest event leads', () => {
    const kept = filterToHorizon(
      [event('Later', '2026-09-14'), event('Sooner', '2026-08-28')],
      today,
    );
    expect(kept.map((e) => e.name)).toEqual(['Sooner', 'Later']);
  });

  /** Verification is one search per event, so an over-long enumeration is a
   *  direct cost multiplier on every refresh. */
  it('caps the list so a dense season cannot balloon the search count', () => {
    const many = Array.from({ length: MAX_CALENDAR_EVENTS + 8 }, (_unused, i) =>
      event(`Event ${i}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}`),
    );
    expect(filterToHorizon(many, today)).toHaveLength(MAX_CALENDAR_EVENTS);
  });

  it('drops an unparseable date rather than sorting it to the front', () => {
    const kept = filterToHorizon([event('Vague', 'sometime in September')], today);
    expect(kept).toHaveLength(0);
  });
});

describe('buildCalendarVerificationQuery', () => {
  /** The whole point of enumerating first: it turns a question search cannot
   *  answer ("what is coming up") into one it can (a named entity). */
  it('names the event and pins it to its year', () => {
    const req = buildCalendarVerificationQuery(event('Raksha Bandhan', '2026-08-28'), 'IN');
    expect(req.query).toContain('Raksha Bandhan');
    expect(req.query).toContain('2026');
    expect(req.query).toContain('India');
  });

  it('uses the market it is given, not a hardcoded country', () => {
    const req = buildCalendarVerificationQuery(event('Thanksgiving', '2026-11-26'), 'US');
    expect(req.query).toContain('the United States');
    expect(req.query).not.toContain('India');
  });

  /**
   * A date filter narrow enough to be worth setting would cut the explainer
   * pages that carry the date being checked — the year in the query text
   * already scopes it to this occurrence.
   */
  it('sets no recency window, unlike the trend queries', () => {
    const req = buildCalendarVerificationQuery(event('Onam', '2026-08-26'), 'IN');
    expect(req.recencyDays).toBeUndefined();
  });
});

describe('keepCorroborated', () => {
  const events = filterToHorizon(
    [event('Real Festival', '2026-08-28'), event('Invented Festival', '2026-09-02')],
    '2026-08-24',
  );

  /** Every signal must carry a source URL, and the pipeline's standing rule is
   *  that nothing reaches a pool item without evidence behind it. */
  it('keeps an event a targeted search actually found', () => {
    const kept = keepCorroborated(
      events,
      new Map([['Real Festival', [result('https://a.example')]]]),
    );
    expect(kept.map((e) => e.name)).toEqual(['Real Festival']);
    expect(kept[0]!.results).toHaveLength(1);
  });

  it('drops an event nothing corroborates', () => {
    const kept = keepCorroborated(
      events,
      new Map([['Real Festival', [result('https://a.example')]]]),
    );
    expect(kept.some((e) => e.name === 'Invented Festival')).toBe(false);
  });

  it('drops an event whose search returned an empty list', () => {
    expect(keepCorroborated(events, new Map([['Real Festival', []]]))).toHaveLength(0);
  });

  it('keeps nothing when the search step produced nothing at all', () => {
    expect(keepCorroborated(events, new Map())).toHaveLength(0);
  });
});

describe('describeCalendarForPrompt', () => {
  const verified = keepCorroborated(
    filterToHorizon([event('Raksha Bandhan', '2026-08-28')], '2026-08-24'),
    new Map([['Raksha Bandhan', [result('https://a.example')]]]),
  );

  /** `daysAway` is spelled out because it is the basis of the freshness score,
   *  and date arithmetic is the thing a model most reliably gets wrong. */
  it('states the date and how far off it is', () => {
    const text = describeCalendarForPrompt(verified);
    expect(text).toContain('Raksha Bandhan');
    expect(text).toContain('2026-08-28');
    expect(text).toContain('in 4 days');
  });

  it('carries the customs and the audience the model has to write against', () => {
    const text = describeCalendarForPrompt(verified);
    expect(text).toContain('People exchange gifts.');
    expect(text).toContain('observed nationwide');
  });

  it('says TODAY and TOMORROW rather than a day count', () => {
    const soon = keepCorroborated(
      filterToHorizon(
        [event('Today Fest', '2026-08-24'), event('Tomorrow Fest', '2026-08-25')],
        '2026-08-24',
      ),
      new Map([
        ['Today Fest', [result('https://a.example')]],
        ['Tomorrow Fest', [result('https://b.example')]],
      ]),
    );
    const text = describeCalendarForPrompt(soon);
    expect(text).toContain('TODAY');
    expect(text).toContain('TOMORROW');
  });

  /** An empty calendar must contribute nothing to the prompt, so a category
   *  bucket's prompt stays exactly what it was before this existed. */
  it('is empty for an empty calendar', () => {
    expect(describeCalendarForPrompt([])).toBe('');
  });
});
