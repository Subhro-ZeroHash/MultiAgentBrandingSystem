import { describe, expect, it } from 'vitest';
import { buildTavilyRequestBody, mapTavilyResult } from './tavily.search.js';

describe('buildTavilyRequestBody', () => {
  it('carries the query through unchanged', () => {
    const body = buildTavilyRequestBody({ query: 'trending sarees Jaipur' });
    expect(body.query).toBe('trending sarees Jaipur');
  });

  it('defaults to the general topic', () => {
    expect(buildTavilyRequestBody({ query: 'x' }).topic).toBe('general');
  });

  it('maps a news-topic request to Tavily\'s news topic', () => {
    expect(buildTavilyRequestBody({ query: 'x', topic: 'news' }).topic).toBe('news');
  });

  it('clamps maxResults to the documented ceiling', () => {
    expect(buildTavilyRequestBody({ query: 'x', maxResults: 500 }).max_results).toBe(20);
  });

  it('clamps maxResults up to at least 1', () => {
    expect(buildTavilyRequestBody({ query: 'x', maxResults: 0 }).max_results).toBe(1);
  });

  it('defaults maxResults when unspecified', () => {
    expect(buildTavilyRequestBody({ query: 'x' }).max_results).toBe(8);
  });

  it('omits days and country when not requested, rather than sending nulls', () => {
    const body = buildTavilyRequestBody({ query: 'x' });
    expect(body).not.toHaveProperty('days');
    expect(body).not.toHaveProperty('country');
  });

  it('includes days only when recencyDays is set', () => {
    expect(buildTavilyRequestBody({ query: 'x', recencyDays: 14 }).days).toBe(14);
  });

  it('never asks Tavily to synthesize an answer — this is a raw-results interface', () => {
    // The whole point of WebSearchService is returning sources for the caller
    // to ground its own prompt in, not trusting a provider's own summary.
    expect(buildTavilyRequestBody({ query: 'x' }).include_answer).toBe(false);
  });
});

describe('mapTavilyResult', () => {
  it('maps a well-formed row', () => {
    const result = mapTavilyResult({
      url: 'https://example.com/a',
      title: '  Diwali sale trends  ',
      content: '  Retailers are seeing a spike in festive demand.  ',
      published_date: '2026-10-01',
    });
    expect(result).toEqual({
      url: 'https://example.com/a',
      title: 'Diwali sale trends',
      snippet: 'Retailers are seeing a spike in festive demand.',
      publishedAt: '2026-10-01',
    });
  });

  it('returns null for a row with no URL, which cannot be a citable source', () => {
    expect(mapTavilyResult({ url: '', title: 'No URL' })).toBeNull();
  });

  it('reports a missing title as null, not an empty string', () => {
    const result = mapTavilyResult({ url: 'https://example.com/a' });
    expect(result?.title).toBeNull();
  });

  it('reports a missing publish date as null', () => {
    const result = mapTavilyResult({ url: 'https://example.com/a', title: 'A' });
    expect(result?.publishedAt).toBeNull();
  });

  it('defaults an absent snippet to an empty string, not undefined', () => {
    const result = mapTavilyResult({ url: 'https://example.com/a' });
    expect(result?.snippet).toBe('');
  });
});
