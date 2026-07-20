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
};

/** Flat per-image rates in micro-USD. Verify before relying on these. */
export const IMAGE_RATES: Record<string, number> = {
  'gemini-3-pro-image-preview': 40_000,
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
