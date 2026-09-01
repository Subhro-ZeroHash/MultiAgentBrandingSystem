import { describeError, withTimeout } from '@bmas/ai';
import { eq, schema, type Brand } from '@bmas/db';
import { DEFAULT_MARKET, marketName, type CostEvent } from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

/**
 * Normalizes a brand's free-text location into the ISO country code the
 * research pool (Layer A) is bucketed by — the market counterpart of
 * `category-classifier.ts`, and lazy and cached for exactly the same reasons.
 *
 * Needed because the pool is *shared*. Every pool query used to be hardcoded
 * to India, so a brand in New York was served Indian festivals and Indian
 * industry news. Market has to be part of the bucket key for two brands in
 * different countries to stop sharing a pool, and a free-text location
 * ("Jaipur", "NYC", "Greater London") has to be normalized before it can key
 * anything.
 *
 * `marketCodeClassifiedFor` records the exact location text the cached code
 * was derived from; editing the location changes that string, which is how a
 * stale classification is detected and re-run without a dirty flag every
 * unrelated field edit would also have to clear.
 */

const CLASSIFY_TIMEOUT_MS = 15_000;

/** Free-form rather than an enum of the countries we happen to have names
 *  for: the model should be able to answer "PT" for Lisbon even before
 *  Portugal is in MARKET_NAMES, and `marketName` degrades to the bare code
 *  rather than failing. */
const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['country'],
  properties: {
    country: {
      type: 'string',
      description:
        'The ISO 3166-1 alpha-2 country code the business trades in, uppercase — "IN" for ' +
        'India, "US" for the United States. Infer the country from a city or region name. ' +
        'Answer "XX" only if the text names no identifiable place.',
    },
  },
} as const;

const classifyResultSchema = z.object({
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'expected a two-letter country code'),
});

async function recordCost(ctx: WorkerContext, brandId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    // Not tied to one research run — classification happens once, lazily, on
    // whichever research run needs it first, and is cached after.
    referenceId: brandId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

export async function ensureBrandMarket(ctx: WorkerContext, brand: Brand): Promise<string> {
  const [row] = await ctx.db
    .select({
      marketCode: schema.brandContexts.marketCode,
      marketCodeClassifiedFor: schema.brandContexts.marketCodeClassifiedFor,
      location: schema.brandContexts.location,
    })
    .from(schema.brandContexts)
    .where(eq(schema.brandContexts.brandId, brand.id))
    .limit(1);

  // Same precedence getTrendContext gives it: the stated context's location
  // wins over the Brand Kit's, being the phrase the user actually used.
  const sourceText = row?.location?.trim() || brand.location?.trim() || null;

  if (row?.marketCode && row.marketCodeClassifiedFor === sourceText) {
    return row.marketCode;
  }

  // Nothing to classify from. Deliberately not cached: a brand that has not
  // filled in a location yet should be re-checked once it does, rather than
  // being pinned to the default market forever.
  if (!sourceText) {
    console.warn(
      `[market-classifier] brand ${brand.id} has no location yet, using '${DEFAULT_MARKET}'`,
    );
    return DEFAULT_MARKET;
  }

  console.warn(`[market-classifier] classifying brand ${brand.id} ("${sourceText}")...`);

  try {
    const { value, cost } = await withTimeout(
      ctx.ai.llm().generateJson<{ country: string }>(
        {
          role: 'volume',
          system:
            'You map a business location to its ISO 3166-1 alpha-2 country code. The text may ' +
            'be a city, a region, or a country. Answer with the code alone.',
          messages: [{ role: 'user', content: `Business location: ${sourceText}` }],
          schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
          parse: (raw) => classifyResultSchema.parse(raw),
        },
        { brandId: brand.id },
      ),
      CLASSIFY_TIMEOUT_MS,
      'market classification',
    );
    await recordCost(ctx, brand.id, cost);

    // "XX" is the model's own "no identifiable place" answer. Treated like
    // missing text — fall back without caching, so a later, clearer location
    // still gets a real classification.
    if (value.country === 'XX') {
      console.warn(
        `[market-classifier] brand ${brand.id}: "${sourceText}" names no identifiable country, using '${DEFAULT_MARKET}'`,
      );
      return DEFAULT_MARKET;
    }

    // Upsert rather than update: a brand whose Brand Brain screen was never
    // opened has no `brand_contexts` row yet, and an update against a missing
    // row would silently do nothing.
    await ctx.db
      .insert(schema.brandContexts)
      .values({
        brandId: brand.id,
        marketCode: value.country,
        marketCodeClassifiedFor: sourceText,
      })
      .onConflictDoUpdate({
        target: schema.brandContexts.brandId,
        set: { marketCode: value.country, marketCodeClassifiedFor: sourceText },
      });

    console.warn(
      `[market-classifier] brand ${brand.id} trades in ${marketName(value.country)} (${value.country})`,
    );
    return value.country;
  } catch (error) {
    // Never fatal to the research run that triggered it: a brand still gets
    // researched against the default market rather than failing outright.
    console.error(
      `[market-classifier] brand ${brand.id} classification failed, using '${DEFAULT_MARKET}': ${describeError(error)}`,
    );
    return DEFAULT_MARKET;
  }
}
