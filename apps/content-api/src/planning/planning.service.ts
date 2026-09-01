import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, recordFeedbackSignal, schema, type Database } from '@bmas/db';
import {
  QUEUES,
  inboxUrgency,
  type CreativeRequest,
  type InboxItem,
  type PlanItemStatus,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import {
  DATABASE,
  PLAN_DIRECTIVE_QUEUE,
  PLAN_ITEM_REPLACE_QUEUE,
  PLAN_SYNTHESIS_QUEUE,
} from '../core/core.module.js';
import { GenerationsService } from '../generations/generations.service.js';

/**
 * The Marketing Plan API.
 *
 * Three surfaces, one rule between them: **approval is the only thing that
 * spends money.** The planner proposes for free, the chat re-plans for the
 * price of a couple of model calls, and neither ever produces an image. Only
 * `approveItem` enqueues a generation, and it does so for exactly one item at
 * a time, because that is the granularity at which the user can see what they
 * are agreeing to.
 */
@Injectable()
export class PlanningService {
  private readonly logger = new Logger(PlanningService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PLAN_SYNTHESIS_QUEUE) private readonly planQueue: Queue,
    @Inject(PLAN_DIRECTIVE_QUEUE) private readonly directiveQueue: Queue,
    @Inject(PLAN_ITEM_REPLACE_QUEUE) private readonly replaceQueue: Queue,
    private readonly generations: GenerationsService,
  ) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
  }

  // -------------------------------------------------------------------------
  // Reading the plan
  // -------------------------------------------------------------------------

  /** The brand's current plan with its items, or null before the first one. */
  async getActivePlan(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const [plan] = await this.db
      .select()
      .from(schema.marketingPlans)
      .where(
        and(eq(schema.marketingPlans.brandId, brandId), eq(schema.marketingPlans.status, 'active')),
      )
      .orderBy(desc(schema.marketingPlans.createdAt))
      .limit(1);

    if (!plan) return null;

    const items = await this.db
      .select()
      .from(schema.planItems)
      .where(eq(schema.planItems.planId, plan.id))
      .orderBy(asc(schema.planItems.sequence));

    return { ...plan, items };
  }

  /** Previous plans, newest first — what the brand used to be doing. */
  async listPlanHistory(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.marketingPlans)
      .where(eq(schema.marketingPlans.brandId, brandId))
      .orderBy(desc(schema.marketingPlans.createdAt))
      .limit(20);
  }

  /**
   * Asks for a fresh plan.
   *
   * Keyed per brand per minute so an impatient double-tap collapses into one
   * generation rather than two racing planners — the same dedupe the GEO
   * prompt refresh uses, and for the same reason.
   */
  async requestPlan(
    brandId: string,
    ownerId: string,
    opts: { focus?: string | null; horizonDays?: number } = {},
  ): Promise<{ queuedAt: string }> {
    await this.assertBrandOwned(brandId, ownerId);

    const queuedAt = new Date();
    await this.planQueue.add(
      QUEUES.contentPlanSynthesis,
      {
        brandId,
        directiveId: null,
        focus: opts.focus ?? null,
        horizonDays: opts.horizonDays ?? 14,
      },
      {
        jobId: `${brandId}-${queuedAt.toISOString().slice(0, 16).replace(/:/g, '')}`,
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );

    this.logger.log(`Queued plan synthesis for brand ${brandId}`);
    return { queuedAt: queuedAt.toISOString() };
  }

  // -------------------------------------------------------------------------
  // The steering chat
  // -------------------------------------------------------------------------

  async listDirectives(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.planDirectives)
      .where(eq(schema.planDirectives.brandId, brandId))
      .orderBy(asc(schema.planDirectives.createdAt))
      .limit(100);
  }

  /**
   * Sends one steering message.
   *
   * The row is written synchronously and the work queued, so the user's own
   * message appears in the chat instantly — a chat that waits for a model call
   * before echoing what you typed feels broken, whatever it is doing.
   */
  async sendDirective(brandId: string, ownerId: string, text: string) {
    await this.assertBrandOwned(brandId, ownerId);

    const [plan] = await this.db
      .select({ id: schema.marketingPlans.id })
      .from(schema.marketingPlans)
      .where(
        and(eq(schema.marketingPlans.brandId, brandId), eq(schema.marketingPlans.status, 'active')),
      )
      .limit(1);

    const [directive] = await this.db
      .insert(schema.planDirectives)
      .values({
        brandId,
        planId: plan?.id ?? null,
        role: 'user',
        text,
        status: 'pending',
      })
      .returning();

    if (!directive) throw new Error('Directive insert returned no row');

    await this.directiveQueue.add(
      QUEUES.contentPlanDirective,
      { directiveId: directive.id, brandId },
      {
        jobId: directive.id,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );

    this.logger.log(`Queued directive ${directive.id} for brand ${brandId}`);
    return directive;
  }

  // -------------------------------------------------------------------------
  // Approval — the only path that spends
  // -------------------------------------------------------------------------

  /**
   * Approves one item and starts its generation.
   *
   * The status check is not a formality: it is what stops a double-tap, a
   * retried request, or a stale client from paying for the same images twice.
   * Only `proposed` can be approved, and the row moves to `generating` in the
   * same breath as the enqueue.
   */
  async approveItem(itemId: string, ownerId: string) {
    const item = await this.loadItem(itemId, ownerId);

    if (item.status !== 'proposed') {
      throw new BadRequestException(
        `This item is already ${item.status}. Only a proposed item can be approved.`,
      );
    }
    if (!item.productId) {
      throw new BadRequestException(
        'This item has no product attached, so there is nothing to generate from. Add a product to your brand and ask for a new plan.',
      );
    }

    const [brand] = await this.db
      .select({ languages: schema.brands.languages })
      .from(schema.brands)
      .where(eq(schema.brands.id, item.brandId))
      .limit(1);
    const brandLanguage = brand?.languages?.[0] ?? 'en';

    const request: CreativeRequest = {
      brandId: item.brandId,
      productId: item.productId,
      campaignType: item.suggestedRequest.campaignType,
      styleTemplate: item.suggestedRequest.styleTemplate,
      outputFormat: item.suggestedRequest.outputFormat,
      // The plan stores these nullable; CreativeRequest treats them as
      // optional. Spread rather than `?? undefined` so an absent field is
      // genuinely absent, which is what the brief composer checks for.
      ...(item.suggestedRequest.headlineText
        ? { headlineText: item.suggestedRequest.headlineText }
        : {}),
      ...(item.suggestedRequest.offerText ? { offerText: item.suggestedRequest.offerText } : {}),
      ...(item.suggestedRequest.extraInstructions
        ? { extraInstructions: item.suggestedRequest.extraInstructions }
        : {}),
      // One variant, not the interactive flow's three: a plan can hold five
      // approved items, and three variants each would triple the spend of
      // saying yes to a plan.
      variantCount: 1,
      variantMode: 'uniform',
      // The brand's first language — the plan was written for this audience,
      // so the creative should speak to it rather than defaulting to English.
      language: brandLanguage,
    };

    // Keyed on the item, so a retry of this call reuses the same generation
    // rather than starting a second one. Hyphen, not a colon: this key becomes
    // the BullMQ job id, and BullMQ rejects ':' in a custom one.
    const job = await this.generations.enqueue(request, `plan-item-${item.id}`, ownerId);

    await this.db
      .update(schema.planItems)
      .set({
        status: 'generating',
        approvedAt: new Date(),
        generationJobId: job.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.planItems.id, item.id));

    // The Brand Brain learns from this: an approval is the clearest statement
    // of what this brand actually wants made.
    await recordFeedbackSignal(this.db, {
      brandId: item.brandId,
      kind: 'approved',
      summary: `Approved for generation: ${item.title}`,
      value: item.title,
      detail: { source: 'plan-item', planItemId: item.id, rationale: item.rationale },
    });

    this.logger.log(`Plan item ${item.id} approved — generation ${job.id}`);
    return { id: item.id, status: 'generating' as PlanItemStatus, generationJobId: job.id };
  }

  /**
   * Rejects one item.
   *
   * Deliberately asks for no reason: a required "why?" is how feedback UIs stop
   * being used. The title and rationale are recorded instead, which is enough
   * for the planner to avoid proposing the same thing again.
   */
  async rejectItem(itemId: string, ownerId: string) {
    const item = await this.loadItem(itemId, ownerId);

    if (item.status !== 'proposed') {
      throw new BadRequestException(
        `This item is already ${item.status}, so there is nothing to reject.`,
      );
    }

    await this.db
      .update(schema.planItems)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(schema.planItems.id, item.id));

    await recordFeedbackSignal(this.db, {
      brandId: item.brandId,
      kind: 'rejected',
      type: 'topic',
      summary: `Rejected from the plan: ${item.title}`,
      value: item.title,
      detail: { source: 'plan-item', planItemId: item.id, rationale: item.rationale },
    });

    this.logger.log(`Plan item ${item.id} rejected`);
    return { id: item.id, status: 'rejected' as PlanItemStatus };
  }

  /**
   * Dismisses a proposal and asks for a different idea in its place.
   *
   * Rejection and replacement are one call rather than two, because they are
   * one intent — "not this, give me another" — and splitting them would let a
   * client reject without ever asking, silently shrinking the plan. The
   * rejection is recorded synchronously so the item leaves the list at once;
   * the replacement is a model call and runs in the worker.
   *
   * The reject is deliberately committed even if queueing the replacement
   * fails: the user said no, and honouring that half is better than pretending
   * neither happened. The plan is simply one item shorter, and they can ask
   * again.
   */
  async replaceItem(itemId: string, ownerId: string): Promise<{ id: string; queuedAt: string }> {
    const item = await this.loadItem(itemId, ownerId);

    if (item.status !== 'proposed') {
      throw new BadRequestException(
        `This item is already ${item.status}, so there is nothing to swap out.`,
      );
    }

    await this.db
      .update(schema.planItems)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(schema.planItems.id, item.id));

    // Filed as a topic rejection so the Brand Brain stops proposing this kind
    // of thing, exactly as a plain skip does — asking for an alternative is
    // still a "no" to what was offered.
    await recordFeedbackSignal(this.db, {
      brandId: item.brandId,
      kind: 'rejected',
      type: 'topic',
      summary: `Asked for a different idea instead of: ${item.title}`,
      value: item.title,
      detail: { source: 'plan-item-replace', planItemId: item.id },
    });

    const queuedAt = new Date();
    await this.replaceQueue.add(
      QUEUES.contentPlanItemReplace,
      { planItemId: item.id, brandId: item.brandId },
      {
        // One replacement per dismissed item, ever. A double-tap cannot buy two
        // new proposals for the same rejection.
        jobId: `replace-${item.id}`,
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 4_000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );

    this.logger.log(`Plan item ${item.id} dismissed; replacement queued`);
    return { id: item.id, queuedAt: queuedAt.toISOString() };
  }

  private async loadItem(itemId: string, ownerId: string) {
    const [item] = await this.db
      .select()
      .from(schema.planItems)
      .where(eq(schema.planItems.id, itemId))
      .limit(1);
    if (!item) throw new NotFoundException(`Plan item ${itemId} not found`);
    await this.assertBrandOwned(item.brandId, ownerId);
    return item;
  }

  // -------------------------------------------------------------------------
  // The in-app approval inbox
  // -------------------------------------------------------------------------

  /**
   * Everything waiting on the user, in one ranked feed.
   *
   * One query per source and a merge in memory rather than a UNION: the three
   * tables share no useful shape, the per-brand counts are small, and a merge
   * here is far easier to change than SQL that has to keep four column lists
   * aligned. Ranking is `inboxUrgency` in @bmas/shared — a pure function, so
   * every client orders the feed identically and it does not reshuffle between
   * refreshes.
   */
  async getInbox(brandId: string, ownerId: string): Promise<InboxItem[]> {
    await this.assertBrandOwned(brandId, ownerId);
    const now = new Date();

    // Only the ACTIVE plan's items. A superseded plan's proposals are history:
    // the user replaced that plan, and continuing to ask them to approve items
    // from it means a redirect never actually clears anything — the inbox just
    // accumulates two plans' worth of decisions, including ones the user
    // implicitly rejected by steering away.
    const [activePlan] = await this.db
      .select({ id: schema.marketingPlans.id })
      .from(schema.marketingPlans)
      .where(
        and(eq(schema.marketingPlans.brandId, brandId), eq(schema.marketingPlans.status, 'active')),
      )
      .limit(1);

    const [items, posts, opportunities, replies] = await Promise.all([
      activePlan
        ? this.db
            .select()
            .from(schema.planItems)
            .where(
              and(
                eq(schema.planItems.planId, activePlan.id),
                eq(schema.planItems.status, 'proposed'),
              ),
            )
            .orderBy(asc(schema.planItems.sequence))
            .limit(30)
        : Promise.resolve([]),

      this.db
        .select()
        .from(schema.scheduledPosts)
        .where(
          and(
            eq(schema.scheduledPosts.brandId, brandId),
            eq(schema.scheduledPosts.status, 'pending_approval'),
          ),
        )
        .limit(30),

      this.loadActionableOpportunities(brandId),

      this.db
        .select()
        .from(schema.planDirectives)
        .where(
          and(eq(schema.planDirectives.brandId, brandId), eq(schema.planDirectives.role, 'agent')),
        )
        .orderBy(desc(schema.planDirectives.createdAt))
        .limit(1),
    ]);

    const feed: InboxItem[] = [
      ...items.map((i) => ({
        id: i.id,
        kind: 'plan_item' as const,
        brandId,
        title: i.title,
        detail: i.rationale,
        urgency: inboxUrgency('plan_item', i.createdAt, now),
        createdAt: i.createdAt,
      })),
      ...posts.map((p) => ({
        id: p.id,
        kind: 'scheduled_post' as const,
        brandId,
        title: 'A generated post is ready to review',
        detail: p.caption?.slice(0, 160) ?? 'Approve it to publish at its scheduled time.',
        urgency: inboxUrgency('scheduled_post', p.createdAt, now),
        createdAt: p.createdAt,
      })),
      ...opportunities.map((o) => ({
        id: o.id,
        kind: 'opportunity' as const,
        brandId,
        title: o.title,
        detail: o.recommendation,
        urgency: inboxUrgency('opportunity', o.createdAt, now),
        createdAt: o.createdAt,
      })),
      ...replies.map((r) => ({
        id: r.id,
        kind: 'directive_reply' as const,
        brandId,
        title: 'The planner replied',
        detail: r.text.slice(0, 200),
        urgency: inboxUrgency('directive_reply', r.createdAt, now),
        createdAt: r.createdAt,
      })),
    ];

    return feed.sort(
      (a, b) => b.urgency - a.urgency || b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /** Time-sensitive opportunities the user has not dealt with. Reached through
   *  the brand's runs, since opportunities carry no brandId of their own. */
  private async loadActionableOpportunities(brandId: string) {
    const runs = await this.db
      .select({ id: schema.trendResearchRuns.id })
      .from(schema.trendResearchRuns)
      .where(eq(schema.trendResearchRuns.brandId, brandId))
      .orderBy(desc(schema.trendResearchRuns.createdAt))
      .limit(2);
    if (runs.length === 0) return [];

    return this.db
      .select({
        id: schema.trendOpportunities.id,
        title: schema.trendOpportunities.title,
        recommendation: schema.trendOpportunities.recommendation,
        createdAt: schema.trendOpportunities.createdAt,
      })
      .from(schema.trendOpportunities)
      .where(
        and(
          inArray(
            schema.trendOpportunities.runId,
            runs.map((r) => r.id),
          ),
          eq(schema.trendOpportunities.status, 'new'),
          // Only the ones worth interrupting someone for. A low-tier idea
          // belongs in the trends screen, not in a list titled "needs you".
          eq(schema.trendOpportunities.actionTier, 'immediate_action'),
        ),
      )
      .orderBy(desc(schema.trendOpportunities.createdAt))
      .limit(10);
  }
}
