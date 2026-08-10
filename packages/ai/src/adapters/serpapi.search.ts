import { ProviderError, ProviderNotConfiguredError } from '../errors.js';
import { buildCostEvent, priceSearch } from '../pricing.js';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '../search.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface SerpApiSearchConfig {
  apiKey: string | undefined;
  baseUrl?: string;
}

interface SerpApiOrganicResult {
  link?: string;
  title?: string;
  snippet?: string;
}

interface SerpApiNewsResult {
  link?: string;
  title?: string;
  snippet?: string;
  date?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  news_results?: SerpApiNewsResult[];
  error?: string;
}

const MODEL = 'serpapi-search';
const MAX_RESULTS = 20;

/**
 * Builds the query params SerpApi's Google engine expects. Exported and pure,
 * same split as buildTavilyRequestBody — testable without a network call.
 *
 * `tbm=nws` switches to Google's News vertical, matching `req.topic ===
 * 'news'` the same way Tavily's `topic` param does; SerpApi has no combined
 * "general or news" toggle, it's a different results array entirely
 * (`news_results` vs `organic_results`), which is why mapSerpApiResponse below
 * branches on it rather than merging both.
 */
export function buildSerpApiParams(req: WebSearchRequest, apiKey: string): URLSearchParams {
  const params = new URLSearchParams({
    engine: 'google',
    q: req.query,
    api_key: apiKey,
    num: String(Math.min(Math.max(req.maxResults ?? 8, 1), MAX_RESULTS)),
  });
  if (req.topic === 'news') params.set('tbm', 'nws');
  // SerpApi's `gl` wants a two-letter country code; a free-text locality (a
  // city name) doesn't fit it, so only a value that already looks like one is
  // forwarded — anything else is silently dropped rather than sent wrong.
  if (req.locale && /^[a-z]{2}$/i.test(req.locale)) params.set('gl', req.locale.toLowerCase());
  return params;
}

/** Maps one SerpApi response into the shared result shape, branching on which
 *  array the engine actually populated. Exported for the same reason as
 *  buildSerpApiParams — pure, worth pinning independently. */
export function mapSerpApiResponse(body: SerpApiResponse): WebSearchResult[] {
  if (body.news_results?.length) {
    return body.news_results
      .filter((row): row is SerpApiNewsResult & { link: string } => Boolean(row.link))
      .map((row) => ({
        url: row.link,
        title: row.title?.trim() || null,
        snippet: row.snippet?.trim() ?? '',
        publishedAt: row.date ?? null,
      }));
  }
  return (body.organic_results ?? [])
    .filter((row): row is SerpApiOrganicResult & { link: string } => Boolean(row.link))
    .map((row) => ({
      url: row.link,
      title: row.title?.trim() || null,
      snippet: row.snippet?.trim() ?? '',
      publishedAt: null,
    }));
}

/**
 * Second web/news search provider, deliberately behind the same
 * `WebSearchService` interface Tavily implements. The signal pipeline
 * (trend-research.ts) queries every *configured* search provider for the same
 * query and stores each provider's results as independent signals — a topic
 * two providers both surface independently is stronger evidence than either
 * alone, which is the entire point of a signal model over a single API.
 *
 * Unconfigured by default: `isConfigured()` is false with no `SERPAPI_KEY`,
 * the same degrade-gracefully behaviour every other adapter in this file has.
 * The signal pipeline treats "0 configured search providers besides Tavily"
 * as the normal case until a key is added.
 */
export class SerpApiSearchAdapter implements WebSearchService {
  readonly provider = 'serpapi';
  private readonly baseUrl: string;

  constructor(private readonly config: SerpApiSearchConfig) {
    this.baseUrl = config.baseUrl ?? 'https://serpapi.com';
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async search(
    req: WebSearchRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<WebSearchResult[]>> {
    if (!this.config.apiKey) {
      throw new ProviderNotConfiguredError('serpapi', 'SERPAPI_KEY');
    }

    const startedAt = Date.now();
    const params = buildSerpApiParams(req, this.config.apiKey);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search.json?${params.toString()}`, {
        method: 'GET',
        signal: ctx?.signal,
      });
    } catch (error) {
      throw new ProviderError(`SerpApi request failed: ${String(error)}`, 'serpapi', {
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = (body as SerpApiResponse | null)?.error ?? response.statusText;
      throw new ProviderError(`SerpApi returned ${response.status}: ${message}`, 'serpapi', {
        // A 401 is a bad key and will never succeed on retry; rate limits and
        // server errors usually do.
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const body = (await response.json()) as SerpApiResponse;
    if (body.error) {
      // SerpApi returns 200 with an `error` field for some failure modes
      // (e.g. a malformed query) rather than a non-2xx status — checked
      // separately from the !response.ok branch above for that reason.
      throw new ProviderError(`SerpApi error: ${body.error}`, 'serpapi', { retryable: false });
    }

    const results = mapSerpApiResponse(body);
    const latencyMs = Date.now() - startedAt;

    return {
      value: results,
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'trend:search',
        costMicroUsd: priceSearch(MODEL),
        latencyMs,
      }),
    };
  }
}
