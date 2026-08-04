import { describe, expect, it } from 'vitest';
import { buildSerpApiParams, mapSerpApiResponse } from './serpapi.search.js';

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
      { url: 'https://example.com/a', title: 'Diwali sale trends', snippet: 'spike', publishedAt: null },
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
