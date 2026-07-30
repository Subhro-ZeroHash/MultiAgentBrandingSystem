import { buildCostEvent } from '../pricing.js';
import type { WebSearchRequest, WebSearchResult, WebSearchService } from '../search.js';
import type { ProviderContext, ProviderResult } from '../types.js';

const MODEL = 'stub-search';

/**
 * Deterministic offline stand-in for `WebSearchService`.
 *
 * Same role as `StubImageAdapter`: not a test mock, a real implementation of
 * the interface that returns real (if fabricated) result objects, so the
 * trend-research pipeline — query building, synthesis prompting, storage — is
 * exercisable without a Tavily key and without spending on every local run or
 * CI pass. Every result is labelled `stub.invalid`, an address in the
 * IETF-reserved `.invalid` TLD (RFC 2606) that can never resolve, so a stub
 * result can never be mistaken for something a user could actually click.
 *
 * Selected only when `WEB_SEARCH_PROVIDER=stub`; the default stays `tavily`.
 */
export class StubSearchAdapter implements WebSearchService {
  readonly provider = 'stub';

  isConfigured(): boolean {
    return true;
  }

  async search(
    req: WebSearchRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<WebSearchResult[]>> {
    const startedAt = Date.now();
    const count = Math.min(req.maxResults ?? 5, 5);
    const today = new Date().toISOString().slice(0, 10);

    const results: WebSearchResult[] = Array.from({ length: count }, (_unused, i) => ({
      url: `https://stub.invalid/result-${i + 1}?q=${encodeURIComponent(req.query)}`,
      title: `[stub] Result ${i + 1} for "${req.query}"`,
      snippet: `Placeholder search result standing in for a live Tavily query about "${req.query}". No real content — WEB_SEARCH_PROVIDER=stub is active.`,
      publishedAt: today,
    }));

    return {
      value: results,
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'trend:search',
        costMicroUsd: 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
