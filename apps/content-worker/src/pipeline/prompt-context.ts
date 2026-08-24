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
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
};

/**
 * Rendered in Asia/Kolkata because every query this pipeline builds is scoped
 * to India — a run just after midnight UTC would otherwise date itself to the
 * previous day for the market it is actually about.
 */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', DATE_FORMAT).format(now);
}

/** Month and year, for embedding in a search query so the engine biases
 *  toward current coverage rather than an evergreen article from years back. */
export function currentMonthInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
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
export function dateGrounding(now: Date = new Date()): string {
  return (
    `Today is ${todayInIndia(now)}.\n\n` +
    'Anything whose moment has already passed is not an opportunity, however ' +
    'well known it is. A festival, sale, holiday or event dated earlier than ' +
    'today is stale — do not propose it, and do not treat a search result ' +
    'about it as current. Favour what is happening now or arriving within the ' +
    'next few weeks. If a signal carries no date and you cannot tell whether ' +
    'it is current, treat it as weaker evidence rather than assuming it is ' +
    'recent.\n\n'
  );
}
