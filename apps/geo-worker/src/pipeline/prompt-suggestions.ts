import { withRetry, withTimeout } from '@bmas/ai';
import { and, count, eq, inArray, schema } from '@bmas/db';
import { ACTIVE_ANSWER_ENGINES, promptIntentSchema, type PromptIntent } from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

/**
 * Autonomous Tracked-Prompt Suggestions.
 *
 * Content generation already has a self-driving loop (trend research ->
 * opportunity -> auto-generated creative); GEO's tracked prompts had no
 * equivalent — a human had to type every question the platform asks AI
 * engines about the brand. This closes that gap: for every brand with
 * autopilot on, keep a baseline of brand-grounded tracked prompts topped up
 * automatically, the same "no click required" bar content's auto-trigger
 * already clears.
 *
 * Reuses `content.automation_settings.contentAutomationEnabled` rather than a
 * GEO-specific flag — the product is one "autopilot" switch spanning both
 * workstreams, not two the user has to keep in sync.
 */

const TARGET_ACTIVE_PROMPTS = 6;
const SUGGESTION_TIMEOUT_MS = 60_000;
const MAX_PRODUCTS_IN_PROMPT = 8;
const MAX_EXISTING_IN_PROMPT = 12;

const promptSuggestionDraftSchema = z.object({
  prompts: z
    .array(
      z.object({
        text: z.string().min(3).max(500),
        intent: promptIntentSchema,
      }),
    )
    .min(1),
});

const PROMPT_SUGGESTION_JSON_SCHEMA = z.toJSONSchema(promptSuggestionDraftSchema) as Record<
  string,
  unknown
>;

const INTENT_EXAMPLE: Record<PromptIntent, string> = {
  discovery: '"best sportswear brand for running"',
  comparison: '"X vs Y for wedding wear"',
  brand_direct: '"is <brand> any good"',
  transactional: '"where can I buy <product> online"',
  informational: '"how do I care for a silk saree"',
};

/**
 * Fans out over every brand with autopilot on and tops each one up to
 * `TARGET_ACTIVE_PROMPTS`. Mirrors `enqueueRollups`' shape in sweep.ts — one
 * tick, whichever brands qualify when it fires — but the brand population is
 * `automation_settings`, not `tracked_prompts`, since a brand that has never
 * had a single prompt still needs to be found.
 */
export async function runPromptSuggestionSweep(ctx: WorkerContext): Promise<number> {
  const brands = await ctx.db
    .select({ brandId: schema.automationSettings.brandId })
    .from(schema.automationSettings)
    .where(eq(schema.automationSettings.contentAutomationEnabled, true));

  let broughtUpToDate = 0;
  for (const { brandId } of brands) {
    try {
      const generated = await topUpPromptsForBrand(ctx, brandId);
      if (generated > 0) {
        broughtUpToDate += 1;
        console.warn(`[prompt-suggestions] brand ${brandId}: generated ${generated} prompt(s)`);
      }
    } catch (error) {
      console.error(
        `[prompt-suggestions] brand ${brandId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return broughtUpToDate;
}

async function topUpPromptsForBrand(ctx: WorkerContext, brandId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(schema.trackedPrompts)
    .where(
      and(eq(schema.trackedPrompts.brandId, brandId), eq(schema.trackedPrompts.isActive, true)),
    );
  const needed = TARGET_ACTIVE_PROMPTS - (row?.value ?? 0);
  if (needed <= 0) return 0;

  const drafted = await draftPromptsForBrand(ctx, brandId, needed);
  if (drafted.length === 0) return 0;

  const inserted = await ctx.db
    .insert(schema.trackedPrompts)
    .values(drafted)
    .returning({ id: schema.trackedPrompts.id });

  return inserted.length;
}

/**
 * Replaces a brand's suggested prompts with a freshly generated set, leaving
 * every user-added prompt exactly where it is.
 *
 * Order matters: the new set is generated FIRST and the old one is retired
 * only once that succeeds, inside a transaction. Retiring first would mean a
 * failed or timed-out model call leaves the brand with nothing to probe —
 * a refresh button that can empty the dashboard is worse than one that
 * occasionally does nothing.
 *
 * Retiring is `isActive = false`, not a delete: `geo.probe_runs.prompt_id`
 * cascades, so deleting a prompt would take its measurement history — and with
 * it the mentions and visibility score derived from that history — with it.
 */
export async function regenerateSuggestedPrompts(
  ctx: WorkerContext,
  brandId: string,
): Promise<{ retired: number; created: number }> {
  const drafted = await draftPromptsForBrand(ctx, brandId, TARGET_ACTIVE_PROMPTS);
  if (drafted.length === 0) return { retired: 0, created: 0 };

  return ctx.db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: schema.trackedPrompts.id })
      .from(schema.trackedPrompts)
      .where(
        and(
          eq(schema.trackedPrompts.brandId, brandId),
          eq(schema.trackedPrompts.source, 'suggested'),
          eq(schema.trackedPrompts.isActive, true),
        ),
      );

    if (stale.length > 0) {
      await tx
        .update(schema.trackedPrompts)
        .set({ isActive: false })
        .where(
          inArray(
            schema.trackedPrompts.id,
            stale.map((p) => p.id),
          ),
        );
    }

    const created = await tx
      .insert(schema.trackedPrompts)
      .values(drafted)
      .returning({ id: schema.trackedPrompts.id });

    return { retired: stale.length, created: created.length };
  });
}

/**
 * The shared half: ask the model for `wanted` brand-grounded prompts and
 * return rows ready to insert. Used by both the unattended top-up and the
 * user-triggered refresh so the two cannot drift into writing different
 * prompts from the same brand.
 */
async function draftPromptsForBrand(
  ctx: WorkerContext,
  brandId: string,
  wanted: number,
): Promise<(typeof schema.trackedPrompts.$inferInsert)[]> {
  const needed = wanted;
  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, brandId))
    .limit(1);
  if (!brand) return [];

  const [products, [brandContext], existing] = await Promise.all([
    ctx.db
      .select({
        name: schema.products.name,
        description: schema.products.description,
        sellingPoints: schema.products.sellingPoints,
      })
      .from(schema.products)
      .where(eq(schema.products.brandId, brandId))
      .limit(MAX_PRODUCTS_IN_PROMPT),
    ctx.db
      .select()
      .from(schema.brandContexts)
      .where(eq(schema.brandContexts.brandId, brandId))
      .limit(1),
    // Live prompts only, which on a refresh means the user's own prompts plus
    // the suggested set about to be retired. Both belong here: duplicating a
    // user's prompt is waste, and a "refresh" that returns the same six
    // questions is not a refresh. Sets retired by earlier refreshes are
    // excluded on purpose, so old ground becomes available again rather than
    // being ruled out forever.
    ctx.db
      .select({ text: schema.trackedPrompts.text })
      .from(schema.trackedPrompts)
      .where(
        and(eq(schema.trackedPrompts.brandId, brandId), eq(schema.trackedPrompts.isActive, true)),
      )
      .limit(MAX_EXISTING_IN_PROMPT),
  ]);

  const { value: draft, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          system:
            'You write the questions a real buyer would type into ChatGPT, Gemini, or Perplexity ' +
            "when researching a purchase — not marketing copy, not the brand's own words. Each one " +
            'gets asked verbatim to a real AI assistant to see whether this brand comes up in the ' +
            'answer, so it has to read like an honest, specific buyer intent, in the language a ' +
            'customer actually thinks in.\n\n' +
            'One prompt per intent below, mixed across the batch, not all the same shape:\n' +
            Object.entries(INTENT_EXAMPLE)
              .map(([intent, example]) => `- ${intent}: e.g. ${example}`)
              .join('\n') +
            "\n\nGround every prompt in the brand's real category, audience, and location — a prompt " +
            'about a product or place this brand has nothing to do with is worthless. Never mention ' +
            'the brand name itself except in a brand_direct or comparison prompt, where a real buyer ' +
            'would actually type it.',
          messages: [
            {
              role: 'user',
              content: [
                `Business: ${brand.name}, category: ${brand.category ?? 'not specified'}.`,
                brand.audience ? `Audience: ${brand.audience}.` : '',
                brand.location
                  ? `Trades from: ${brand.location} — write locally-phrased prompts a buyer there would use.`
                  : '',
                brandContext?.positioning
                  ? `What sets this brand apart: ${brandContext.positioning}`
                  : '',
                brandContext?.goals.length ? `Goals: ${brandContext.goals.join('; ')}` : '',
                brandContext?.competitors.length
                  ? `Real competitors, usable in comparison prompts: ${brandContext.competitors.map((c) => c.name).join(', ')}`
                  : '',
                products.length
                  ? `Products:\n${products.map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n')}`
                  : 'No products on file yet — write prompts about the business/category in general.',
                existing.length
                  ? `Already tracking these — do not repeat them or anything nearly identical:\n${existing.map((p) => `- ${p.text}`).join('\n')}`
                  : '',
                '',
                `Write exactly ${needed} new prompt(s).`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          schema: PROMPT_SUGGESTION_JSON_SCHEMA,
          parse: (raw) => promptSuggestionDraftSchema.parse(raw),
        },
        { referenceId: brandId, brandId },
      ),
      SUGGESTION_TIMEOUT_MS,
      'prompt-suggestions:generate',
    ),
  );

  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'geo',
    referenceId: brandId,
    provider: cost.provider,
    model: cost.model,
    operation: 'geo:prompt-suggest',
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    latencyMs: cost.latencyMs ?? null,
    costMicroUsd: cost.costMicroUsd,
  });

  return draft.prompts.slice(0, needed).map((p) => ({
    brandId,
    text: p.text,
    intent: p.intent,
    locale: brand.location,
    // ACTIVE_ANSWER_ENGINES, not a literal — an unattended weekly probe
    // silently picking up Claude or another engine the moment its
    // credentials start working would spend real money nobody decided
    // to spend. See that constant for which engine(s) this deployment
    // currently has both a working key and sign-off to spend on for GEO.
    engines: [...ACTIVE_ANSWER_ENGINES],
    // Everything this function writes is machine-written and therefore
    // replaceable by a later refresh. User-typed prompts come in through
    // the API, which always writes 'user'.
    source: 'suggested' as const,
    isActive: true,
  }));
}
