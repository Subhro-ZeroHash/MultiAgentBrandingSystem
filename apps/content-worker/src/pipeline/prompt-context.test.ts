import { describe, expect, it } from 'vitest';
import { currentMonthInIndia, dateGrounding, todayInIndia } from './prompt-context.js';

describe('todayInIndia', () => {
  it('renders a full, unambiguous date', () => {
    // 23 Aug 2026 is a Sunday.
    expect(todayInIndia(new Date('2026-08-23T09:00:00Z'))).toBe('Sunday, 23 August 2026');
  });

  /** A run just after midnight UTC is already the next day in the market every
   *  query here is scoped to; dating it a day behind would make "today" wrong
   *  exactly when a festival window opens. */
  it('uses the Indian calendar day, not the UTC one', () => {
    // 22:00 UTC on the 22nd is 03:30 on the 23rd in Asia/Kolkata.
    expect(todayInIndia(new Date('2026-08-22T22:00:00Z'))).toBe('Sunday, 23 August 2026');
  });
});

describe('currentMonthInIndia', () => {
  it('gives a month and year for embedding in a search query', () => {
    expect(currentMonthInIndia(new Date('2026-08-23T09:00:00Z'))).toBe('August 2026');
  });
});

describe('dateGrounding', () => {
  it("states today's date", () => {
    expect(dateGrounding(new Date('2026-08-23T09:00:00Z'))).toContain(
      'Today is Sunday, 23 August 2026.',
    );
  });

  /**
   * The Republic Day bug: the model was told its own knowledge might be stale
   * but never given a reference point, so it surfaced a festival seven months
   * past. Stating the date alone is not enough — the consequence has to be
   * spelled out, or a well-known past event still reads as an opportunity.
   */
  it('rules out events whose moment has passed', () => {
    const text = dateGrounding(new Date('2026-08-23T09:00:00Z'));
    expect(text).toMatch(/already passed/i);
    expect(text).toMatch(/do not propose it/i);
  });

  it('tells the model how to treat an undated signal', () => {
    expect(dateGrounding(new Date('2026-08-23T09:00:00Z'))).toMatch(/no date/i);
  });
});
