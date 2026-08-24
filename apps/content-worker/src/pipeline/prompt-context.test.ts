import { describe, expect, it } from 'vitest';
import {
  currentMonthInMarket,
  dateGrounding,
  isoDateInMarket,
  todayInMarket,
} from './prompt-context.js';

describe('todayInMarket', () => {
  it('renders a full, unambiguous date', () => {
    // 23 Aug 2026 is a Sunday.
    expect(todayInMarket('IN', new Date('2026-08-23T09:00:00Z'))).toBe('Sunday, 23 August 2026');
  });

  /** A run just after midnight UTC is already the next day in the market the
   *  query is scoped to; dating it a day behind would make "today" wrong
   *  exactly when a festival window opens. */
  it("uses the market's calendar day, not the UTC one", () => {
    // 22:00 UTC on the 22nd is 03:30 on the 23rd in Asia/Kolkata.
    expect(todayInMarket('IN', new Date('2026-08-22T22:00:00Z'))).toBe('Sunday, 23 August 2026');
  });

  /**
   * The same instant is two different days in two markets, which is the whole
   * reason these are market-scoped: a single shared rendering is necessarily
   * wrong for one of them, and "has this date passed?" is the question every
   * research prompt is being asked to answer.
   */
  it('gives two markets their own day for the same instant', () => {
    const instant = new Date('2026-08-22T22:00:00Z');
    expect(todayInMarket('IN', instant)).toBe('Sunday, 23 August 2026');
    expect(todayInMarket('US', instant)).toBe('Saturday, 22 August 2026');
  });

  /** An unmapped market falls back to UTC rather than throwing — wrong by
   *  hours at worst, where guessing a region could be wrong by a day. */
  it('still renders a date for an unmapped market', () => {
    expect(todayInMarket('ZZ', new Date('2026-08-23T09:00:00Z'))).toBe('Sunday, 23 August 2026');
  });
});

describe('currentMonthInMarket', () => {
  it('gives a month and year for embedding in a search query', () => {
    expect(currentMonthInMarket('IN', new Date('2026-08-23T09:00:00Z'))).toBe('August 2026');
  });

  /** Month rolls over at the market's local midnight too, not UTC's. */
  it("rolls over on the market's own calendar", () => {
    const instant = new Date('2026-08-31T22:00:00Z');
    expect(currentMonthInMarket('IN', instant)).toBe('September 2026');
    expect(currentMonthInMarket('US', instant)).toBe('August 2026');
  });
});

describe('isoDateInMarket', () => {
  it('renders YYYY-MM-DD, zero-padded', () => {
    expect(isoDateInMarket('IN', new Date('2026-01-05T09:00:00Z'))).toBe('2026-01-05');
  });

  it('agrees with the prose date about which day it is', () => {
    const instant = new Date('2026-08-22T22:00:00Z');
    expect(isoDateInMarket('IN', instant)).toBe('2026-08-23');
    expect(isoDateInMarket('US', instant)).toBe('2026-08-22');
  });
});

describe('dateGrounding', () => {
  const instant = new Date('2026-08-23T09:00:00Z');

  it("states today's date and the market it is today in", () => {
    const text = dateGrounding('IN', instant);
    expect(text).toContain('Today is Sunday, 23 August 2026 in India.');
  });

  /**
   * The Republic Day bug: the model was told its own knowledge might be stale
   * but never given a reference point, so it surfaced a festival seven months
   * past. Stating the date alone is not enough — the consequence has to be
   * spelled out, or a well-known past event still reads as an opportunity.
   */
  it('rules out events whose moment has passed', () => {
    const text = dateGrounding('IN', instant);
    expect(text).toMatch(/already passed/i);
    expect(text).toMatch(/do not propose it/i);
  });

  it('tells the model how to treat an undated signal', () => {
    expect(dateGrounding('IN', instant)).toMatch(/no date/i);
  });

  it('grounds a US run in the US date, not the Indian one', () => {
    const text = dateGrounding('US', new Date('2026-08-22T22:00:00Z'));
    expect(text).toContain('Saturday, 22 August 2026');
    expect(text).toContain('the United States');
  });
});
