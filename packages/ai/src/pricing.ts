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
 * Per-second video rates, in micro-USD, keyed by the standard resolution name
 * ("1080" for 1080p) — LTX prices identically for a given pixel count
 * regardless of orientation (`1920x1080` and `1080x1920` are the same rate),
 * so one row covers both rather than doubling every entry for
 * portrait/landscape. The number is the *short* edge of that resolution's
 * 16:9 landscape pair (1080p is 1920x1080 — 1080 is the height, not the long
 * edge), matching how the industry actually names these tiers.
 *
 * VERIFIED against docs.ltx.io/pricing directly (fetched 2026-08-27), not
 * estimated from training data — LTX is a new integration with no prior spend
 * to sanity-check against, so an approximate rate here would under- or
 * over-report real cost from the very first call with nothing to catch it.
 * Re-check before relying on this for a billing decision regardless; LTX's own
 * pricing page is the source of truth and can move.
 */
export const VIDEO_RATES: Record<string, Record<number, number>> = {
  'ltx-2-5-fast': { 720: 90_000, 1080: 130_000, 1440: 190_000, 2160: 300_000 },
  'ltx-2-5-pro': { 720: 120_000, 1080: 170_000 },
  'ltx-2-3-fast': { 720: 30_000, 1080: 60_000, 1440: 120_000, 2160: 240_000 },
  'ltx-2-3-pro': { 720: 40_000, 1080: 80_000, 1440: 160_000, 2160: 320_000 },
  // Verified against ai.google.dev/gemini-api/docs/pricing on 2026-08-31 —
  // Veo has no 1440 tier (see gemini.video.ts's RESOLUTION_TIERS), so
  // priceVideo's "snap to nearest tier at or above" falls straight from
  // 1080 to nothing higher, same as LTX's own -pro rows above.
  'veo-3.1-fast-generate-preview': { 720: 100_000, 1080: 120_000 },
  'veo-3.1-generate-preview': { 720: 400_000, 1080: 400_000 },
};

/**
 * `resolutionTier` is the standard resolution name (1080 for both `1920x1080`
 * and `1080x1920`) — the same value `nearestVideoResolution` in ltx.video.ts
 * resolves a request to and bills at, so a caller never needs to re-derive it
 * from raw pixels. Falls to the nearest tier at or above the request rather
 * than zero on an exact-match miss: resolution tiers are the fixed set LTX
 * actually prices, so a request between two isn't a missing rate the way an
 * unknown model id is — it is charged at the next tier up, the same way LTX
 * itself would bill an unlisted in-between size, rather than silently
 * reporting zero for a model that IS priced.
 */
export function priceVideo(model: string, resolutionTier: number, durationSeconds: number): number {
  const rates = VIDEO_RATES[model];
  if (!rates) return 0;

  const tiers = Object.keys(rates)
    .map(Number)
    .sort((a, b) => a - b);
  const tier = tiers.find((candidate) => candidate >= resolutionTier) ?? tiers[tiers.length - 1];
  if (tier === undefined) return 0;

  return Math.round(rates[tier]! * durationSeconds);
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
/**
 * TODO(content): UNVERIFIED. SerpApi bills per search on a monthly plan
 * (e.g. $75/5,000 searches on the Developer plan) rather than pay-as-you-go
 * credits; this estimates the per-search marginal cost on that tier so the
 * ledger isn't silently zero. Re-check against SerpApi's pricing page before
 * relying on this for a real unit-economics number.
 */
export const SEARCH_RATES: Record<string, number> = {
  'tavily-search': 8_000,
  'serpapi-search': 15_000,
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
