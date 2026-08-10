import type { ProviderContext, ProviderResult } from './types.js';

export interface WebSearchResult {
  url: string;
  title: string | null;
  /** A short excerpt the provider already extracted from the page — not the
   *  full page, and not something callers fetch themselves. */
  snippet: string;
  /** ISO date the provider believes the content was published, when it
   *  reports one. Null is common; not every result carries a date. */
  publishedAt: string | null;
}

export interface WebSearchRequest {
  query: string;
  /** Country/region code or free-text locality; ignored by a provider with no
   *  locale support. */
  locale?: string | null;
  /** Bias toward results from the last N days. A trend search wants "this
   *  week", not whatever ranks best regardless of age. */
  recencyDays?: number;
  maxResults?: number;
  /** Restrict to a news-like vertical when the provider distinguishes one. */
  topic?: 'general' | 'news';
}

/**
 * Real-time web search — raw results, no synthesis.
 *
 * Kept apart from `LlmService` and `AnswerEngineClient` on purpose. Both of
 * those return an answer already composed by a model; this returns the
 * sources themselves, so a caller can ground its *own* prompt in them rather
 * than trusting a provider's summary of what it found. The Trend Research
 * Agent is the first consumer: it needs facts an LLM's training data cannot
 * supply (this week's news, this month's events), then does its own
 * brand-aware filtering and scoring on top of what comes back here.
 */
export interface WebSearchService {
  readonly provider: string;

  /** True when credentials are present. A caller can check this before
   *  spending a round trip on a request that will only fail. */
  isConfigured(): boolean;

  search(req: WebSearchRequest, ctx?: ProviderContext): Promise<ProviderResult<WebSearchResult[]>>;
}
