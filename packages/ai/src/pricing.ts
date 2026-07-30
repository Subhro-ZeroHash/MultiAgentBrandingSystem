import type { CostEvent } from '@bmas/shared';

/**
 * Per-model rates in micro-USD, used to turn provider usage into ledger rows.
 *
 * These are cached list prices and WILL drift — treat them as an estimate for
 * unit-economics dashboards, not as billing truth. Re-check against live
 * provider pricing pages before making a pricing decision on top of them.
 */
interface TokenRate {
  /** Micro-USD per input token. */
  inputMicroUsd: number;
  /** Micro-USD per output token. */
  outputMicroUsd: number;
  /** Micro-USD per cached input token, when the provider bills them apart. */
  cachedInputMicroUsd?: number;
}

const perMillion = (usd: number) => (usd * 1_000_000) / 1_000_000;

export const TOKEN_RATES: Record<string, TokenRate> = {
  // Anthropic — $/MTok converted to micro-USD per token.
  'claude-opus-4-8': { inputMicroUsd: perMillion(5), outputMicroUsd: perMillion(25) },
  'claude-sonnet-5': { inputMicroUsd: perMillion(3), outputMicroUsd: perMillion(15) },
  'claude-haiku-4-5': { inputMicroUsd: perMillion(1), outputMicroUsd: perMillion(5) },

  // TODO(content): UNVERIFIED rates. The model ids are confirmed live (see
  // GEMINI_MODELS in registry.ts) but their prices were not — a model with no
  // entry here prices at zero, which under-reports spend silently, so these
  // estimates stand in until the pricing page is checked.
  'gemini-3.1-pro-preview': { inputMicroUsd: perMillion(1.25), outputMicroUsd: perMillion(10) },
  'gemini-3.6-flash': { inputMicroUsd: perMillion(0.3), outputMicroUsd: perMillion(2.5) },
};

/**
 * Flat per-image rates in micro-USD. Verify before relying on these.
 *
 * Every id the adapter can be pointed at needs an entry: `priceImages` returns
 * zero for an unknown model, so a missing row is not an error but a silently
 * free-looking image. The stable `gemini-3-pro-image` was absent while being
 * the configured default, which reported a whole job's image spend as 0.
 */
export const IMAGE_RATES: Record<string, number> = {
  // TODO(content): UNVERIFIED, as with TOKEN_RATES above. The -preview twin and
  // the stable id are the same model tier, so they carry the same estimate.
  'gemini-3-pro-image': 40_000,
  'gemini-3-pro-image-preview': 40_000,
  'gemini-2.5-flash-image': 40_000,
  'fal-ai/flux-pro/kontext': 40_000,
};

export function priceTokens(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
): number {
  const rate = TOKEN_RATES[model];
  if (!rate) return 0;

  const input = (usage.inputTokens ?? 0) * rate.inputMicroUsd;
  const output = (usage.outputTokens ?? 0) * rate.outputMicroUsd;
  const cached =
    (usage.cachedInputTokens ?? 0) * (rate.cachedInputMicroUsd ?? rate.inputMicroUsd * 0.1);

  return Math.round(input + output + cached);
}

export function priceImages(model: string, count: number): number {
  return Math.round((IMAGE_RATES[model] ?? 0) * count);
}

/**
 * Flat per-call rates in micro-USD for providers billed by the call rather
 * than by token or image — currently just web search.
 *
 * TODO(content): UNVERIFIED. Tavily bills in credits (1 for a basic search) at
 * roughly $8 per 1,000 credits on paid tiers; the free tier's 1,000
 * credits/month cost nothing. This estimates the paid-tier marginal cost so
 * the ledger is not silently zero once free-tier volume is exhausted.
 * Re-check against Tavily's pricing page before relying on this for a real
 * unit-economics number.
 */
export const SEARCH_RATES: Record<string, number> = {
  'tavily-search': 8_000,
};

export function priceSearch(model: string): number {
  return SEARCH_RATES[model] ?? 0;
}

export function buildCostEvent(
  input: Omit<CostEvent, 'costMicroUsd'> & { costMicroUsd?: number },
): CostEvent {
  return {
    ...input,
    costMicroUsd:
      input.costMicroUsd ??
      (input.imageCount
        ? priceImages(input.model, input.imageCount)
        : priceTokens(input.model, input)),
  };
}
