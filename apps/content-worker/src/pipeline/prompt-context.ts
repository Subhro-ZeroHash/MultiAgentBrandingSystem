import { DEFAULT_MARKET, marketName, marketTimeZone } from '@bmas/shared';

/**
 * Date grounding for every research prompt.
 *
 * A model has no idea what day it is. Left unsaid, it falls back on whatever
 * seasonal marketing its training data associates with the category — which is
 * how a run in late August proposed Republic Day sale promotions, an event
 * seven months past. The pool-synthesis prompt already warned the model its own
 * knowledge "might be stale by months", but gave it no reference point to
 * measure staleness against, so the instruction was unactionable.
 *
 * This is also what makes `urgency` and `freshness` scoreable at all: both are
 * defined relative to now ("how soon the window to act closes"), and no model
 * can judge that without knowing when now is.
 *
 * Every function here is market-scoped. "Today" is a local fact, and these
 * dates are compared against local observances: a run at 20:00 UTC is already
 * the next day in India and still the same afternoon in New York, so a single
 * shared rendering would be a day out for one of them exactly when a festival
 * window opens.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};

/** The market's own calendar day, written out in full. */
export function todayInMarket(market: string = DEFAULT_MARKET, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    ...DATE_FORMAT,
    timeZone: marketTimeZone(market),
  }).format(now);
}

/** Month and year, for embedding in a search query so the engine biases
 *  toward current coverage rather than an evergreen article from years back. */
export function currentMonthInMarket(
  market: string = DEFAULT_MARKET,
  now: Date = new Date(),
): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: marketTimeZone(market),
  }).format(now);
}

/**
 * The ISO `YYYY-MM-DD` of the market's today.
 *
 * Separate from `todayInMarket` because this one is arithmetic, not prose:
 * it anchors the horizon window a calendar enumeration is bounded to, and is
 * compared against model-supplied ISO dates. Built from `en-CA`, whose short
 * format is already ISO order, so no manual part-juggling is needed.
 */
export function isoDateInMarket(market: string = DEFAULT_MARKET, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: marketTimeZone(market),
  }).format(now);
}

/**
 * The block prepended to every research prompt's system message.
 *
 * States the date, then draws the consequence explicitly. Stating the date
 * alone is not enough: a model will still surface a well-known past festival
 * unless told plainly that a passed moment disqualifies an opportunity
 * regardless of how prominent it is.
 */
export function dateGrounding(market: string = DEFAULT_MARKET, now: Date = new Date()): string {
  return (
    `Today is ${todayInMarket(market, now)} in ${marketName(market)}.\n\n` +
    'Anything whose moment has already passed is not an opportunity, however ' +
    'well known it is. A festival, sale, holiday or event dated earlier than ' +
    'today is stale — do not propose it, and do not treat a search result ' +
    'about it as current. Favour what is happening now or arriving within the ' +
    'next few weeks. If a signal carries no date and you cannot tell whether ' +
    'it is current, treat it as weaker evidence rather than assuming it is ' +
    'recent.\n\n'
  );
}
