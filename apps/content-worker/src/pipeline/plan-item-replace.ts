import { describeError, withRetry, withTimeout } from '@bmas/ai';
import { and, desc, eq, getPlanningContext, ne, schema, type PlanningTaskContext } from '@bmas/db';
import {
  plannedItemDraftSchema,
  type ContentPlanItemReplaceJob,
  type CostEvent,
  type PlannedItemDraft,
  type TrendSuggestedRequest,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

/**
 * Replaces one proposal the user dismissed.
 *
 * "I don't like this one, give me a different idea" is the most common thing a
 * person says to a marketing suggestion, and answering it badly is worse than
 * not offering it at all: a replacement that is the dismissed idea reworded
 * teaches the user that the button does nothing.
 *
 * So the whole job of this file is the exclusion list. The model is shown, and
 * told to avoid:
 *
 * - the exact idea just dismissed, and why it was proposed;
 * - every other item currently in the plan, so a replacement cannot collide
 *   with a sibling;
 * - every proposal this brand has *ever* rejected, so repeated dismissals keep
 *   moving into new territory instead of cycling through the same three ideas;
 * - the topics the Brand Brain has learned this brand turns down.
 *
 * It also deliberately requires a different angle rather than merely a
 * different sentence — a new content type or a new hook — because "same idea,
 * new title" is exactly the failure mode a dissatisfied user is trying to
 * escape.
 */

const REPLACE_TIMEOUT_MS = 180_000;
const MAX_REPLACE_TOKENS = 1_200;
/** How far back the rejection memory reaches. Enough that a user dismissing
 *  repeatedly keeps getting new ground; bounded so the prompt cannot grow
 *  without limit on a long-lived brand. */
const MAX_REJECTED_HISTORY = 25;

const REPLACEMENT_JSON_SCHEMA = z.toJSONSchema(plannedItemDraftSchema) as Record<string, unknown>;

/**
 * Drafts and installs the replacement.
 *
 * Returns the new item's id, or null when the item is no longer replaceable —
 * it was approved from another device, or the plan was superseded while this
 * job waited. Both are ordinary races, not failures.
 */
export async function runPlanItemReplace(
  ctx: WorkerContext,
  job: ContentPlanItemReplaceJob,
): Promise<string | null> {
  const [dismissed] = await ctx.db
    .select()
    .from(schema.planItems)
    .where(eq(schema.planItems.id, job.planItemId))
    .limit(1);
  if (!dismissed) {
    console.warn(`[plan-replace] item ${job.planItemId} no longer exists — skipping`);
    return null;
  }

  // The API marks the dismissed item `rejected` before queueing, so anything
  // else means someone got there first.
  if (dismissed.status !== 'rejected') {
    console.warn(
      `[plan-replace] item ${job.planItemId} is ${dismissed.status}, not rejected — skipping`,
    );
    return null;
  }

  const [plan] = await ctx.db
    .select()
    .from(schema.marketingPlans)
    .where(eq(schema.marketingPlans.id, dismissed.planId))
    .limit(1);
  if (!plan || plan.status !== 'active') {
    console.warn(`[plan-replace] plan ${dismissed.planId} is no longer active — skipping`);
    return null;
  }

  const context = await getPlanningContext(ctx.db, job.brandId);
  const [siblings, rejectedHistory] = await Promise.all([
    loadSiblingTitles(ctx, dismissed.planId, dismissed.id),
    loadRejectedTitles(ctx, job.brandId),
  ]);

  const { draft, cost } = await draftReplacement(
    ctx,
    context,
    dismissed,
    siblings,
    rejectedHistory,
  );
  await recordCost(ctx, job.brandId, cost);

  const productId = draft.productIndex === null ? null : (context.products[draft.productIndex]?.id ?? null);
  const suggestedRequest: TrendSuggestedRequest = {
    campaignType: draft.campaignType,
    styleTemplate: draft.styleTemplate,
    outputFormat: draft.outputFormat,
    headlineText: draft.headlineText,
    offerText: draft.offerText,
    extraInstructions: draft.angle,
  };

  const [created] = await ctx.db
    .insert(schema.planItems)
    .values({
      planId: dismissed.planId,
      brandId: job.brandId,
      // Takes the dismissed item's place in the running order, so the plan
      // reads the way it did before rather than growing a tail of swaps.
      sequence: dismissed.sequence,
      title: draft.title,
      rationale: draft.rationale,
      contentType: draft.contentType,
      suggestedRequest,
      productId,
      opportunityId:
        draft.opportunityIndex === null
          ? null
          : (context.opportunities[draft.opportunityIndex]?.id ?? null),
      plannedFor:
        draft.dayOffset === null
          ? dismissed.plannedFor
          : new Date(Date.now() + draft.dayOffset * 24 * 60 * 60_000),
      status: 'proposed',
    })
    .returning({ id: schema.planItems.id });

  if (!created) throw new Error('Replacement insert returned no row');

  console.warn(
    `[plan-replace] brand ${job.brandId}: replaced "${dismissed.title}" with "${draft.title}"`,
  );
  return created.id;
}

/** The other items in this plan — a replacement must not collide with one. */
async function loadSiblingTitles(
  ctx: WorkerContext,
  planId: string,
  excludeItemId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ title: schema.planItems.title })
    .from(schema.planItems)
    .where(and(eq(schema.planItems.planId, planId), ne(schema.planItems.id, excludeItemId)));
  return rows.map((r) => r.title);
}

/**
 * Everything this brand has rejected, across every plan it has ever had.
 *
 * This is what makes repeated dismissals productive rather than circular. A
 * user who says "no" four times should see four genuinely different ideas, not
 * the same two alternating.
 */
async function loadRejectedTitles(ctx: WorkerContext, brandId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ title: schema.planItems.title })
    .from(schema.planItems)
    .where(and(eq(schema.planItems.brandId, brandId), eq(schema.planItems.status, 'rejected')))
    .orderBy(desc(schema.planItems.updatedAt))
    .limit(MAX_REJECTED_HISTORY);
  return rows.map((r) => r.title);
}

async function draftReplacement(
  ctx: WorkerContext,
  context: PlanningTaskContext,
  dismissed: typeof schema.planItems.$inferSelect,
  siblings: string[],
  rejectedHistory: string[],
): Promise<{ draft: PlannedItemDraft; cost: CostEvent }> {
  const productBlock = context.products.length
    ? context.products
        .map((p, i) => `[${i}] ${p.name}${p.description ? ` — ${p.description}` : ''}`)
        .join('\n')
    : 'No products on file. Leave productIndex null.';

  const opportunityBlock = context.opportunities.length
    ? context.opportunities.map((o, i) => `[${i}] ${o.title} — ${o.summary}`).join('\n')
    : 'No live trend opportunities.';

  const { value: draft, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          maxTokens: MAX_REPLACE_TOKENS,
          system:
            'The business owner rejected one proposed piece of content and asked for a different ' +
            'idea. Write exactly one replacement.\n\n' +
            'This must be a genuinely different idea, not a rewording. Change the angle: a ' +
            'different content type, a different hook, a different reason for someone to care. ' +
            'If your replacement could be mistaken for the rejected one, it is wrong.\n\n' +
            'Do not reuse any title or premise in the "already proposed" or "previously ' +
            'rejected" lists. Stay on the plan\'s subject and respect the brand\'s banned ' +
            'topics and learned preferences.',
          messages: [
            {
              role: 'user',
              content: [
                `Business: ${context.identity.brandName}${
                  context.identity.industry ? `, ${context.identity.industry}` : ''
                }${context.identity.location ? `, in ${context.identity.location}` : ''}.`,
                context.identity.audience ? `Audience: ${context.identity.audience}` : '',
                context.identity.bannedTopics.length
                  ? `Never mention: ${context.identity.bannedTopics.join(', ')}`
                  : '',
                context.currentPlanHeadline ? `The plan: "${context.currentPlanHeadline}"` : '',
                '',
                'THE IDEA THEY REJECTED — do not propose anything like it:',
                `"${dismissed.title}" — ${dismissed.rationale}`,
                '',
                siblings.length
                  ? `ALREADY PROPOSED in this plan, do not duplicate:\n${siblings.map((t) => `- ${t}`).join('\n')}`
                  : 'Nothing else is proposed in this plan yet.',
                '',
                rejectedHistory.length
                  ? `PREVIOUSLY REJECTED by this business, do not return to these:\n${rejectedHistory.map((t) => `- ${t}`).join('\n')}`
                  : '',
                context.learnings.length
                  ? `WHAT THIS BUSINESS HAS TAUGHT US:\n${context.learnings
                      .map((l) => `- ${l.summary}`)
                      .join('\n')}`
                  : '',
                '',
                'PRODUCTS:',
                productBlock,
                '',
                'LIVE OPPORTUNITIES:',
                opportunityBlock,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          schema: REPLACEMENT_JSON_SCHEMA,
          parse: (raw) => plannedItemDraftSchema.parse(raw),
        },
        { referenceId: dismissed.id, brandId: context.identity.brandId },
      ),
      REPLACE_TIMEOUT_MS,
      'plan:item-replace',
    ),
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[plan-replace] item ${dismissed.id}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
        ),
    },
  );

  return { draft, cost };
}

/** CLAUDE.md rule 5. */
async function recordCost(ctx: WorkerContext, brandId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: brandId,
    provider: cost.provider,
    model: cost.model,
    operation: 'content:plan-item-replace',
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}
