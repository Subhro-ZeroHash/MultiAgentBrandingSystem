import { ProviderError, ProviderNotConfiguredError } from '../errors.js';
import { buildCostEvent, priceSearch } from '../pricing.js';
import { dropStaleResults } from '../search.js';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '../search.js';
import type { ProviderContext, ProviderResult } from '../types.js';

export interface TavilySearchConfig {
  apiKey: string | undefined;
  baseUrl?: string;
}

interface TavilyResultRow {
  url: string;
  title?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResultRow[];
}

interface TavilyErrorBody {
  detail?: { error?: string } | string;
}

const MODEL = 'tavily-search';

/** Tavily's own ceiling; a caller asking for more would otherwise get a
 *  confusing provider error instead of a clamped, honoured request. */
const MAX_RESULTS = 20;

/**
 * Builds the POST body Tavily expects. Exported and pure so the mapping from
 * our request shape to theirs is testable without a network call — the same
 * split `nearestAspectRatio` in gemini.image.ts uses for its own provider
 * quirks.
 */
export function buildTavilyRequestBody(req: WebSearchRequest): Record<string, unknown> {
  return {
    query: req.query,
    search_depth: 'basic',
    topic: req.topic === 'news' ? 'news' : 'general',
    max_results: Math.min(Math.max(req.maxResults ?? 8, 1), MAX_RESULTS),
    include_answer: false,
    include_raw_content: false,
    ...(req.recencyDays ? { days: req.recencyDays } : {}),
    ...(req.locale ? { country: req.locale } : {}),
  };
}

/** Maps one Tavily row into the shared result shape. Exported for the same
 *  reason as the body builder — pure, worth pinning independently. */
export function mapTavilyResult(row: TavilyResultRow): WebSearchResult | null {
  if (!row.url) return null;
  return {
    url: row.url,
    title: row.title?.trim() || null,
    snippet: row.content?.trim() ?? '',
    publishedAt: row.published_date ?? null,
  };
}

/** Pulls the actionable message out of Tavily's error body, whatever shape it
 *  takes — mirrors `graphErrorMessage` in social.service.ts, same reasoning:
 *  the bare HTTP status tells the caller nothing about what to fix. */
function tavilyErrorMessage(body: unknown, fallback: string): string {
  const detail = (body as TavilyErrorBody | null)?.detail;
  if (typeof detail === 'string') return detail;
  return detail?.error ?? fallback;
}

/**
 * Web search backing the Trend Research Agent. A single REST call, no SDK —
 * matching `PerplexityAnswerEngine`'s reasoning: `fetch` is enough for one
 * endpoint, and it keeps the provider surface to exactly what this codebase
 * actually imports from `@bmas/ai/adapters`.
 *
 * Cost is a flat per-call estimate, not token-based — Tavily bills in search
 * credits, not tokens, so `TOKEN_RATES` does not apply here. See pricing.ts.
 */
export class TavilySearchAdapter implements WebSearchService {
  readonly provider = 'tavily';
  private readonly baseUrl: string;

  constructor(private readonly config: TavilySearchConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.tavily.com';
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async search(
    req: WebSearchRequest,
    ctx?: ProviderContext,
  ): Promise<ProviderResult<WebSearchResult[]>> {
    if (!this.config.apiKey) {
      throw new ProviderNotConfiguredError('tavily', 'TAVILY_API_KEY');
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildTavilyRequestBody(req)),
        signal: ctx?.signal,
      });
    } catch (error) {
      throw new ProviderError(`Tavily request failed: ${String(error)}`, 'tavily', {
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new ProviderError(
        `Tavily returned ${response.status}: ${tavilyErrorMessage(body, response.statusText)}`,
        'tavily',
        // A 401/403 is a bad key and will never succeed on retry; rate limits
        // and server errors usually do.
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = (await response.json()) as TavilyResponse;
    const mapped = (body.results ?? [])
      .map(mapTavilyResult)
      .filter((result): result is WebSearchResult => result !== null);
    // Tavily accepts `days` but does not reliably honour it — a 45-day
    // request has come back with seven-month-old rows — so the window is
    // enforced here rather than trusted.
    const results = dropStaleResults(mapped, req.recencyDays);
    const latencyMs = Date.now() - startedAt;

    return {
      value: results,
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'trend:search',
        // Not token-based; buildCostEvent's usual fallback (priceTokens) would
        // silently read 0 here without this, and 0 looks identical to "free
        // tier" rather than "not priced by tokens at all".
        costMicroUsd: priceSearch(MODEL),
        latencyMs,
      }),
    };
  }
}
