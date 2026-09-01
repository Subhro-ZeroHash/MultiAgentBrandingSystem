import { describeError, withRetry, withTimeout } from '@bmas/ai';
import {
  and,
  eq,
  getPlanningContext,
  recordContextSnapshot,
  renderBrandContextLines,
  schema,
  type PlanningTaskContext,
} from '@bmas/db';
import {
  planDraftSchema,
  type ContentPlanSynthesisJob,
  type CostEvent,
  type PlanDraft,
  type PlanEvidence,
  type TrendSuggestedRequest,
} from '@bmas/shared';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';

/**
 * The Marketing Planner.
 *
 * The strategist of the agent team. Where the trend agent asks "what is
 * happening?" and the content agent asks "how do we make this?", this one asks
 * "what should this brand be doing for the next fortnight, and why?" — and it
 * answers using only what the rest of the system has already learned: the Brand
 * Brain (identity, stated positioning, goals, and the preferences learned from
 * every past approval and rejection), the newest trend opportunities, the
 * competitor intelligence, and the brand's current GEO visibility.
 *
 * Two design rules it exists to enforce:
 *
 * **Nothing is generated here.** A plan is a proposal. One model call drafts
 * the whole thing, while each approved item costs real image spend, so the
 * planner proposes freely and every item waits at `proposed` until a human
 * approves that specific one. This is the single most important property of
 * the file: it is why autopilot can run unattended without spending.
 *
 * **A revision replaces, never edits.** Re-planning writes a new plan row and
 * marks the previous one `superseded` in the same transaction, so "what did my
 * instruction actually change?" stays answerable, and two concurrent runs
 * cannot leave a brand with two active plans.
 */

const PLAN_TIMEOUT_MS = 300_000;
const MAX_PLAN_TOKENS = 4_000;
/** Enough for a fortnight at a sane cadence, few enough that a user can
 *  actually read and judge every one. A plan nobody reads is not a plan. */
const DEFAULT_ITEM_TARGET = 5;

const PLAN_JSON_SCHEMA = z.toJSONSchema(planDraftSchema) as Record<string, unknown>;

/**
 * Drafts a plan and installs it as the brand's active one.
 *
 * Returns the new plan's id, or null when there was nothing to plan with —
 * a brand with no products and no research yet is a legitimate state, not an
 * error, and failing here would put a red banner in front of a user whose only
 * mistake was being new.
 */
export async function runPlanSynthesis(
  ctx: WorkerContext,
  job: ContentPlanSynthesisJob,
): Promise<string | null> {
  const context = await getPlanningContext(ctx.db, job.brandId);

  if (context.products.length === 0 && context.opportunities.length === 0) {
    console.warn(
      `[plan] brand ${job.brandId}: nothing to plan from (no products, no opportunities) — skipping`,
    );
    return null;
  }

  const focus = job.focus ?? null;
  const { draft, cost } = await draftPlan(ctx, context, focus, job.horizonDays);

  await recordCost(ctx, job.brandId, cost);

  // Forensics before the write: if the plan reads oddly later, the first
  // question is what the planner was actually told, and re-deriving it then
  // answers with today's brand rather than the one that ran.
  await recordContextSnapshot(ctx.db, {
    brandId: job.brandId,
    agentType: 'strategy',
    snapshot: {
      focus,
      horizonDays: job.horizonDays,
      directiveId: job.directiveId,
      geoScore: context.geoScore,
      opportunityTitles: context.opportunities.map((o) => o.title),
      intelligenceTitles: context.intelligence.map((i) => i.title),
      learnings: context.learnings.map((l) => `${l.type}: ${l.summary}`),
      supersedes: context.currentPlanHeadline,
    },
  });

  const planId = await installPlan(ctx, job, context, draft, focus);
  console.warn(
    `[plan] brand ${job.brandId}: plan ${planId} — "${draft.headline}" with ${draft.items.length} item(s)`,
  );
  return planId;
}

/**
 * The model call.
 *
 * The prompt is built almost entirely from stored context rather than from
 * anything this file invents: `renderBrandContextLines` is the same renderer
 * the trend and content agents use, so all three describe the brand
 * identically, and the opportunity/intelligence blocks are verbatim what the
 * research agents wrote.
 */
async function draftPlan(
  ctx: WorkerContext,
  context: PlanningTaskContext,
  focus: string | null,
  horizonDays: number,
): Promise<{ draft: PlanDraft; cost: CostEvent }> {
  const itemTarget = Math.max(3, Math.min(DEFAULT_ITEM_TARGET, Math.ceil(horizonDays / 3)));

  const opportunityBlock = context.opportunities.length
    ? context.opportunities
        .map(
          (o, i) =>
            `[${i}] (${o.actionTier}, score ${o.score}) ${o.title} — ${o.summary} Suggested action: ${o.recommendation}`,
        )
        .join('\n')
    : 'No live trend opportunities. Plan from the brand and its products alone.';

  const intelligenceBlock = context.intelligence.length
    ? context.intelligence
        .map((i) => `- (${i.urgency}) ${i.title}: ${i.whyItMatters}`)
        .join('\n')
    : 'No competitor or market intelligence on file yet.';

  const productBlock = context.products.length
    ? context.products.map((p, i) => `[${i}] ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : 'No products on file. Plan brand-level content only, and leave productIndex null.';

  const { value: draft, cost } = await withRetry(() =>
    withTimeout(
      ctx.ai.llm().generateJson(
        {
          role: 'orchestrator',
          maxTokens: MAX_PLAN_TOKENS,
          system:
            'You are the head of marketing for one brand, writing the plan for the next ' +
            `${horizonDays} days. Your audience is the business owner, who will read every ` +
            'line and approve or reject each item individually.\n\n' +
            'Rules:\n' +
            '- Every item must be justified by something you were actually given — a trend ' +
            'opportunity, a piece of intelligence, a stated goal, or a learned preference. ' +
            'If you cannot point to why, do not propose it.\n' +
            '- Cite trend opportunities by their [index] in your rationale where you used them, ' +
            'and set opportunityIndex on the item that came from one.\n' +
            '- Respect what this brand has learned it does and does not want. A preference ' +
            'that says a topic was rejected is not a suggestion.\n' +
            '- Never repeat a title the current plan already proposed.\n' +
            '- Never touch a banned topic.\n' +
            '- The headline is one line the owner reads first: what this plan is trying to ' +
            'move, in their language, not marketing boilerplate.\n' +
            '- Vary content types and spread dayOffset across the horizon. Do not stack ' +
            'everything on day 0.',
          messages: [
            {
              role: 'user',
              content: [
                ...renderBrandContextLines(context),
                '',
                focus
                  ? `THE OWNER HAS ASKED YOU TO FOCUS ON: ${focus}\nThis overrides your own ` +
                    'judgment about subject matter. Build the plan around it. If the live ' +
                    'opportunities below are unrelated to it, say so in the rationale and plan ' +
                    'from the focus anyway.'
                  : 'No specific focus requested — choose the subject yourself from the evidence.',
                '',
                `CURRENT VISIBILITY: ${
                  context.geoScore === null
                    ? 'never measured'
                    : `${context.geoScore}/100 in AI answer engines`
                }`,
                context.currentPlanHeadline
                  ? `PLAN YOU ARE REPLACING: "${context.currentPlanHeadline}". Titles already ` +
                    `proposed (do not repeat): ${context.currentPlanTitles.join('; ') || 'none'}`
                  : 'This is the brand&rsquo;s first plan.',
                '',
                'LIVE TREND OPPORTUNITIES:',
                opportunityBlock,
                '',
                'MARKET & COMPETITOR INTELLIGENCE:',
                intelligenceBlock,
                '',
                'PRODUCTS:',
                productBlock,
                '',
                `Write exactly ${itemTarget} items.`,
              ].join('\n'),
            },
          ],
          schema: PLAN_JSON_SCHEMA,
          parse: (raw) => planDraftSchema.parse(raw),
        },
        { referenceId: context.identity.brandId, brandId: context.identity.brandId },
      ),
      PLAN_TIMEOUT_MS,
      'plan:synthesis',
    ),
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[plan] brand ${context.identity.brandId}: attempt ${attempt} failed, retrying in ${delayMs}ms — ${describeError(error)}`,
        ),
    },
  );

  return { draft, cost };
}

/**
 * Writes the plan and its items, and retires the previous plan.
 *
 * All of it in one transaction: a brand with two `active` plans has no
 * defensible answer to "what are we doing?", and the window between two
 * separate statements is exactly where a crash would leave one.
 */
async function installPlan(
  ctx: WorkerContext,
  job: ContentPlanSynthesisJob,
  context: PlanningTaskContext,
  draft: PlanDraft,
  focus: string | null,
): Promise<string> {
  const now = Date.now();

  return ctx.db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ id: schema.marketingPlans.id })
      .from(schema.marketingPlans)
      .where(
        and(
          eq(schema.marketingPlans.brandId, job.brandId),
          eq(schema.marketingPlans.status, 'active'),
        ),
      )
      .limit(1);

    const evidence: PlanEvidence = {
      // Only the opportunities the planner actually cited, not everything it
      // was shown — the point of evidence is what informed the plan.
      opportunityIds: draft.items
        .map((i) => resolveOpportunityId(context, i.opportunityIndex))
        .filter((id): id is string => id !== null),
      intelligenceItemIds: context.intelligence.map((i) => i.id),
      notes: draft.evidenceNotes,
      geoScoreAtPlanning: context.geoScore,
    };

    // Retire the outgoing plan BEFORE inserting the new one. The order is
    // load-bearing: `marketing_plans_one_active_per_brand_idx` allows a single
    // active row per brand and is checked per statement, not deferred to
    // commit, so inserting first would collide with the plan being replaced.
    if (previous) {
      await tx
        .update(schema.marketingPlans)
        .set({ status: 'superseded' })
        .where(eq(schema.marketingPlans.id, previous.id));
    }

    const [plan] = await tx
      .insert(schema.marketingPlans)
      .values({
        brandId: job.brandId,
        status: 'active',
        origin: job.directiveId ? 'directive' : 'scheduled',
        horizonDays: job.horizonDays,
        headline: draft.headline,
        rationale: draft.rationale,
        focus: focus ?? draft.focus ?? null,
        evidence,
        supersedesId: previous?.id ?? null,
        activatedAt: new Date(),
      })
      .returning({ id: schema.marketingPlans.id });

    if (!plan) throw new Error('Plan insert returned no row');

    await tx.insert(schema.planItems).values(
      draft.items.map((item, index) => {
        const productId = resolveProductId(context, item.productIndex);
        const suggestedRequest: TrendSuggestedRequest = {
          campaignType: item.campaignType,
          styleTemplate: item.styleTemplate,
          outputFormat: item.outputFormat,
          headlineText: item.headlineText,
          offerText: item.offerText,
          extraInstructions: item.angle,
        };
        return {
          planId: plan.id,
          brandId: job.brandId,
          sequence: index,
          title: item.title,
          rationale: item.rationale,
          contentType: item.contentType,
          suggestedRequest,
          productId,
          opportunityId: resolveOpportunityId(context, item.opportunityIndex),
          plannedFor:
            item.dayOffset === null ? null : new Date(now + item.dayOffset * 24 * 60 * 60_000),
          // The line that makes autopilot safe to leave on.
          status: 'proposed' as const,
        };
      }),
    );

    return plan.id;
  });
}

/** Index -> id, tolerating a model that invents an out-of-range position.
 *  A hallucinated index means "no opportunity", never a wrong one. */
function resolveOpportunityId(context: PlanningTaskContext, index: number | null): string | null {
  if (index === null) return null;
  return context.opportunities[index]?.id ?? null;
}

function resolveProductId(context: PlanningTaskContext, index: number | null): string | null {
  if (index === null) return null;
  return context.products[index]?.id ?? null;
}

/** CLAUDE.md rule 5: every provider call records cost. */
async function recordCost(ctx: WorkerContext, brandId: string, cost: CostEvent): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: brandId,
    provider: cost.provider,
    model: cost.model,
    operation: 'content:plan-synthesis',
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}
