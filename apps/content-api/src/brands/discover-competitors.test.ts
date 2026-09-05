import { describe, expect, it } from 'vitest';
import type { AiRegistry } from '@bmas/ai';
import { discoverCompetitors } from './discover-competitors.js';

const baseInput = {
  brandName: 'Priya Sarees',
  industry: 'Saree boutique',
  location: 'Jaipur, India',
  audience: null,
  known: [] as string[],
};

const searchCost = {
  provider: 'tavily',
  model: 'search',
  operation: 'trend:search',
  costMicroUsd: 100,
};

const extractionCost = {
  provider: 'anthropic',
  model: 'claude',
  operation: 'volume',
  costMicroUsd: 200,
};

function fakeAi(overrides: {
  isConfigured?: boolean;
  results?: Array<{ url: string; title: string | null; snippet: string; publishedAt: string | null }>;
  competitors?: unknown[];
}): AiRegistry {
  const results = overrides.results ?? [
    {
      url: 'https://example.com/rival',
      title: 'Rival Sarees',
      snippet: 'A well-known saree boutique in Jaipur.',
      publishedAt: null,
    },
  ];
  const competitors = overrides.competitors ?? [
    { name: 'Rival Sarees', websiteUrl: 'https://rivalsarees.com', note: 'Same city, same audience' },
  ];

  return {
    webSearch: () => ({
      provider: 'tavily',
      isConfigured: () => overrides.isConfigured ?? true,
      search: async () => ({ value: results, cost: searchCost }),
    }),
    llm: () => ({
      provider: 'anthropic',
      generateJson: async () => ({ value: { competitors }, cost: extractionCost }),
    }),
  } as unknown as AiRegistry;
}

describe('discoverCompetitors', () => {
  it('refuses to search with no industry to search for', async () => {
    await expect(
      discoverCompetitors(fakeAi({}), { ...baseInput, industry: null }),
    ).rejects.toThrow(/industry/i);
  });

  it('refuses when no search provider is configured', async () => {
    await expect(
      discoverCompetitors(fakeAi({ isConfigured: false }), baseInput),
    ).rejects.toThrow(/web search provider/i);
  });

  it('returns the search cost alone when the search finds nothing', async () => {
    const result = await discoverCompetitors(fakeAi({ results: [] }), baseInput);
    expect(result.suggestions).toEqual([]);
    expect(result.costs).toEqual([searchCost]);
  });

  it('drops a suggestion that matches a name already on the brand\'s list', async () => {
    const result = await discoverCompetitors(fakeAi({}), {
      ...baseInput,
      known: ['rival sarees'],
    });
    expect(result.suggestions).toEqual([]);
  });

  it('surfaces a genuinely new suggestion with both provider costs recorded', async () => {
    const result = await discoverCompetitors(fakeAi({}), baseInput);
    expect(result.suggestions).toEqual([
      { name: 'Rival Sarees', websiteUrl: 'https://rivalsarees.com', note: 'Same city, same audience' },
    ]);
    expect(result.costs).toEqual([searchCost, extractionCost]);
  });
});
