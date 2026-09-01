import { describe, expect, it } from 'vitest';
import { buildSerpApiParams, isEmptyResultError, mapSerpApiResponse } from './serpapi.search.js';

describe('buildSerpApiParams', () => {
  it('carries the query through unchanged', () => {
    const params = buildSerpApiParams({ query: 'trending sarees Jaipur' }, 'key');
    expect(params.get('q')).toBe('trending sarees Jaipur');
  });

  it('defaults to the google engine with no news vertical', () => {
    const params = buildSerpApiParams({ query: 'x' }, 'key');
    expect(params.get('engine')).toBe('google');
    expect(params.has('tbm')).toBe(false);
  });

  it('switches to the news vertical for a news-topic request', () => {
    expect(buildSerpApiParams({ query: 'x', topic: 'news' }, 'key').get('tbm')).toBe('nws');
  });

  it('clamps maxResults to the documented ceiling', () => {
    expect(buildSerpApiParams({ query: 'x', maxResults: 500 }, 'key').get('num')).toBe('20');
  });

  it('clamps maxResults up to at least 1', () => {
    expect(buildSerpApiParams({ query: 'x', maxResults: 0 }, 'key').get('num')).toBe('1');
  });

  it('defaults maxResults when unspecified', () => {
    expect(buildSerpApiParams({ query: 'x' }, 'key').get('num')).toBe('8');
  });

  it('forwards a two-letter locale as gl', () => {
    expect(buildSerpApiParams({ query: 'x', locale: 'in' }, 'key').get('gl')).toBe('in');
  });

  it('drops a locale that is not a two-letter country code, rather than sending it wrong', () => {
    expect(buildSerpApiParams({ query: 'x', locale: 'Jaipur' }, 'key').has('gl')).toBe(false);
  });

  it('never leaks the api key into a value other than api_key', () => {
    const params = buildSerpApiParams({ query: 'x' }, 'secret-key');
    expect(params.get('api_key')).toBe('secret-key');
  });
});

describe('mapSerpApiResponse', () => {
  it('maps organic results when no news_results are present', () => {
    const results = mapSerpApiResponse({
      organic_results: [
        { link: 'https://example.com/a', title: '  Diwali sale trends  ', snippet: '  spike  ' },
      ],
    });
    expect(results).toEqual([
      {
        url: 'https://example.com/a',
        title: 'Diwali sale trends',
        snippet: 'spike',
        publishedAt: null,
      },
    ]);
  });

  it('prefers news_results over organic_results when both are present', () => {
    const results = mapSerpApiResponse({
      organic_results: [{ link: 'https://example.com/organic', title: 'Organic' }],
      news_results: [
        { link: 'https://example.com/news', title: 'News', snippet: 'a', date: '2026-10-01' },
      ],
    });
    expect(results).toEqual([
      { url: 'https://example.com/news', title: 'News', snippet: 'a', publishedAt: '2026-10-01' },
    ]);
  });

  it('drops a row with no URL, which cannot be a citable source', () => {
    expect(mapSerpApiResponse({ organic_results: [{ title: 'No URL' }] })).toEqual([]);
  });

  it('reports a missing title as null, not an empty string', () => {
    const results = mapSerpApiResponse({ organic_results: [{ link: 'https://example.com/a' }] });
    expect(results[0]?.title).toBeNull();
  });

  it('defaults an absent snippet to an empty string, not undefined', () => {
    const results = mapSerpApiResponse({ organic_results: [{ link: 'https://example.com/a' }] });
    expect(results[0]?.snippet).toBe('');
  });

  it('returns an empty array when neither results array is present', () => {
    expect(mapSerpApiResponse({})).toEqual([]);
  });
});

describe('buildSerpApiParams recency', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  /**
   * The bug this pins: no time filter was sent at all, so a 14-day request
   * got Google's all-time ranking. A query for festivals "in the next 30
   * days" returned a seven-month-old Republic Day sale as its top hit, while
   * Tavily — which did honour recencyDays — returned current coverage for the
   * same query. Half the signals were date-bounded and half were not.
   */
  it('bounds the search to the requested window', () => {
    const params = buildSerpApiParams({ query: 'x', recencyDays: 14 }, 'k', now);
    expect(params.get('tbs')).toBe('cdr:1,cd_min:08/09/2026,cd_max:08/23/2026');
  });

  it('sends no time filter when the caller did not ask for one', () => {
    expect(buildSerpApiParams({ query: 'x' }, 'k', now).get('tbs')).toBeNull();
  });

  /** A 45-day window has no `qdr:` bucket — `qdr:m` would silently drop the
   *  last fortnight, `qdr:y` would let a year of stale coverage back in. */
  it('expresses a window that no coarse qdr bucket matches', () => {
    const params = buildSerpApiParams({ query: 'x', recencyDays: 45 }, 'k', now);
    expect(params.get('tbs')).toBe('cdr:1,cd_min:07/09/2026,cd_max:08/23/2026');
  });
});

describe('isEmptyResultError', () => {
  /**
   * SerpApi reports an empty result set as an `error` field on a 200. Treating
   * that as a provider failure meant one narrow query could sink an entire
   * research run, since the pool refresh aborts when every provider fails —
   * surfacing to the user as "every search provider failed or returned
   * nothing" on a run whose other buckets were fine.
   */
  it('recognises an empty result set as an answer, not a failure', () => {
    expect(isEmptyResultError("Google hasn't returned any results for this query.")).toBe(true);
    expect(isEmptyResultError('No results found for your query')).toBe(true);
  });

  it('still treats real errors as errors', () => {
    expect(isEmptyResultError('Invalid API key')).toBe(false);
    expect(isEmptyResultError('Your account has run out of searches')).toBe(false);
  });
});
