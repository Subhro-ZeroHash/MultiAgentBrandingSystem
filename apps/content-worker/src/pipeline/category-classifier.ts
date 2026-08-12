import { describeError, withTimeout } from '@bmas/ai';
import { eq, schema, type Brand } from '@bmas/db';
import { CATEGORY_KEYS, categoryKeySchema, type CategoryKey, type CostEvent } from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

/**
 * Normalizes a brand's free-text industry into the fixed category taxonomy
 * the research pool (Layer A) is organized by — see
 * packages/shared/src/content/category.ts. `brands.category` and
 * `brand_contexts.industry` are both free text ("artisanal bakery", "D2C
 * running shoes"), which was fine when every brand searched for itself; a
 * *shared* pool needs brands to land in the same bucket to share anything.
 *
 * Lazy and cached: classification runs once, the first time a Layer B
 * research run actually needs it, not at brand creation or on every context
 * read — brand-context reads elsewhere in the app stay LLM-free.
 * `categoryKeyClassifiedFor` records the exact source text the cached
 * `categoryKey` was classified from; an edit to `industry`/`category`
 * changes that string, which is how a stale classification gets re-run
 * without a separate dirty flag every unrelated field edit would also have
 * to know to clear.
 */

const CLASSIFY_TIMEOUT_MS = 15_000;

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: {
    category: { enum: CATEGORY_KEYS },
  },
} as const;

const classifyResultSchema = z.object({ category: categoryKeySchema });

async function recordCost(ctx: WorkerContext, brandId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    // Not tied to one research run — classification happens once, lazily,
    // on whichever research run needs it first, and is cached after.
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

export async function ensureBrandCategoryKey(
  ctx: WorkerContext,
  brand: Brand,
): Promise<CategoryKey> {
  const [row] = await ctx.db
    .select({
      categoryKey: schema.brandContexts.categoryKey,
      categoryKeyClassifiedFor: schema.brandContexts.categoryKeyClassifiedFor,
      industry: schema.brandContexts.industry,
    })
    .from(schema.brandContexts)
    .where(eq(schema.brandContexts.brandId, brand.id))
    .limit(1);

  // The stated context's industry wins over the Brand Kit's taxonomy
  // `category`, same precedence getTrendContext already gives it — it is the
  // phrase the user actually described their business with.
  const sourceText = row?.industry?.trim() || brand.category?.trim() || null;

  if (row?.categoryKey && row.categoryKeyClassifiedFor === sourceText) {
    console.warn(
      `[category-classifier] brand ${brand.id} already classified as '${row.categoryKey}' (cached)`,
    );
    return row.categoryKey;
  }

  // Nothing to classify from — 'other' is the honest answer, but deliberately
  // not cached: a brand with no industry text yet should be re-checked once
  // it has some, not permanently stuck in the fallback bucket.
  if (!sourceText) {
    console.warn(
      `[category-classifier] brand ${brand.id} has no industry/category text yet, using 'other'`,
    );
    return 'other';
  }

  console.warn(`[category-classifier] classifying brand ${brand.id} ("${sourceText}")...`);

  try {
    // Typed and parsed as the whole `{category}` object, not narrowed to the
    // bare string, extracting `.category` after the call — the same
    // `generateJson<{items: [...]}>` + `value.items` shape every other
    // pipeline in this codebase already uses.
    const { value, cost } = await withTimeout(
      ctx.ai.llm().generateJson<{ category: CategoryKey }>(
        {
          role: 'volume',
          system:
            'Classify a small business into exactly one category from the fixed list given by ' +
            'the schema. If none fit well, answer "other". Judge from the description alone.',
          messages: [{ role: 'user', content: `Business description: ${sourceText}` }],
          schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
          parse: (raw) => classifyResultSchema.parse(raw),
        },
        { brandId: brand.id },
      ),
      CLASSIFY_TIMEOUT_MS,
      'category classification',
    );
    await recordCost(ctx, brand.id, cost);

    // Upsert rather than a plain update: a brand whose Brand Brain screen was
    // never opened has no `brand_contexts` row yet (it is normally created
    // lazily by BrandContextService.ensureContext on the content-api side),
    // and an update against a missing row would silently do nothing.
    await ctx.db
      .insert(schema.brandContexts)
      .values({
        brandId: brand.id,
        categoryKey: value.category,
        categoryKeyClassifiedFor: sourceText,
      })
      .onConflictDoUpdate({
        target: schema.brandContexts.brandId,
        set: { categoryKey: value.category, categoryKeyClassifiedFor: sourceText },
      });

    console.warn(
      `[category-classifier] brand ${brand.id} classified as '${value.category}' (cached)`,
    );
    return value.category;
  } catch (error) {
    // Layer B cannot proceed without *some* category — fall back rather than
    // block research on a classifier hiccup. Not cached against the real
    // sourceText, so the next run retries the classification instead of
    // being stuck on a fallback a transient failure caused.
    console.warn(
      `[category-classifier] falling back to 'other' for brand ${brand.id}: ${describeError(error)}`,
    );
    return 'other';
  }
}
