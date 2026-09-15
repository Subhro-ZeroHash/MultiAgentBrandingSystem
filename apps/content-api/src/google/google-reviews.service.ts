import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  getContentContext,
  inArray,
  renderBrandContextLines,
  schema,
  type ContentTaskContext,
  type Database,
  type GoogleReview,
} from '@bmas/db';
import type { AiRegistry } from '@bmas/ai';
import { AI_REGISTRY, DATABASE } from '../core/core.module.js';

type GoogleReviewStatus = GoogleReview['status'];

/** Gemini's "thinking" tokens draw from the same budget as the visible reply
 *  (see GeminiLlmAdapter.usageOf) and this repo doesn't disable thinking (the
 *  Pro tier rejects `thinkingBudget: 0` outright), so a limit sized for just
 *  the 2-4 sentence reply cuts it off mid-word once thinking eats most of it
 *  — confirmed live: 300 truncated a reply after nine words. Matched to
 *  MAX_ANSWER_TOKENS, the closest comparable single-text-answer task. */
const MAX_REVIEW_REPLY_TOKENS = 2_000;

@Injectable()
export class GoogleReviewsService {
  private readonly logger = new Logger(GoogleReviewsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_REGISTRY) private readonly ai: AiRegistry,
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

  /**
   * Reviews carry no human approval step by design: the reply that comes
   * back from `autoReply` is final, not a draft waiting on someone to read
   * it. `listForBrand` is the trigger for that today only because there is
   * no live Google review sync to trigger it instead (no Business Profile
   * API access yet — see GoogleAuthService) — once that sync exists as a
   * BullMQ job, it becomes the real trigger and this sweep is redundant, not
   * wrong: a review already replied to is skipped, so running both costs
   * nothing extra.
   */
  async listForBrand(
    brandId: string,
    ownerId: string,
    status?: GoogleReviewStatus,
    limit = 50,
  ): Promise<GoogleReview[]> {
    await this.assertBrandOwned(brandId, ownerId);

    // Atomically claim pending reviews before drafting anything: this is a
    // GET handler that two overlapping calls (a double-fetch, a user
    // refreshing twice, two open tabs) can both reach at once, and a plain
    // select-then-act would let both see the same `needs_reply` rows and
    // draft — and bill — the same review twice. The `WHERE status =
    // 'needs_reply'` re-checks at UPDATE time, not just at an earlier
    // SELECT, so only the caller whose UPDATE actually commits first claims
    // each row; the other's UPDATE matches zero rows for it. Same
    // conditional-update-as-claim pattern SchedulingService's
    // approve/reject already use for the same reason. `draft_ready` is an
    // otherwise-unused status value from before this feature became fully
    // automatic — repurposed here as the transient "claimed" state.
    const claimed = await this.db
      .update(schema.googleReviews)
      .set({ status: 'draft_ready', updatedAt: new Date() })
      .where(
        and(
          eq(schema.googleReviews.brandId, brandId),
          eq(schema.googleReviews.status, 'needs_reply'),
        ),
      )
      .returning();

    if (claimed.length > 0) {
      // One context build for the whole batch, not one per review: every
      // claimed row here already shares this same `brandId` (the query
      // above is scoped to it), so `getContentContext` would otherwise
      // rebuild an identical brand/site/products/learnings snapshot once
      // per review — real cost (several queries plus the read this itself
      // triggers) paid N times for one answer.
      try {
        const context = await getContentContext(this.db, brandId);
        await Promise.all(
          claimed.map((review) =>
            this.autoReply(review, context).catch((error) => {
              // Release the claim so it's retried next time this brand's
              // reviews are listed, rather than surfacing a 500 for every
              // other review that drafted fine — or leaving this one stuck
              // in 'draft_ready' forever.
              this.logger.error(`Auto-reply failed for review ${review.id}: ${String(error)}`);
              return this.db
                .update(schema.googleReviews)
                .set({ status: 'needs_reply' })
                .where(eq(schema.googleReviews.id, review.id));
            }),
          ),
        );
      } catch (error) {
        // Context failed to build — no review in this batch could have
        // replied correctly without it. Release every claim in the batch
        // rather than leaving them stuck, and log once instead of per review.
        this.logger.error(`Auto-reply context failed for brand ${brandId}: ${String(error)}`);
        await this.db
          .update(schema.googleReviews)
          .set({ status: 'needs_reply' })
          .where(
            inArray(
              schema.googleReviews.id,
              claimed.map((review) => review.id),
            ),
          );
      }
    }

    const conditions = [eq(schema.googleReviews.brandId, brandId)];
    if (status) conditions.push(eq(schema.googleReviews.status, status));
    return this.db
      .select()
      .from(schema.googleReviews)
      .where(and(...conditions))
      .orderBy(desc(schema.googleReviews.reviewedAt))
      .limit(limit);
  }

  /**
   * Drafts a reply in the brand's own voice and finalises it in the same
   * step — same brand context every other generation task reads,
   * `getContentContext`, so a review reply and a caption never disagree
   * about tone, banned topics, etc. `approved` is the real end state today,
   * not `published`: there is no Google API access yet to actually post
   * through (see GoogleAuthService's doc comment), so this is "ready to go
   * out the moment that access lands," not a claim the reply already
   * reached the customer.
   */
  private async autoReply(review: GoogleReview, context: ContentTaskContext): Promise<GoogleReview> {
    const referenceId = `google-review-reply-${review.id}-${Date.now()}`;
    const { value: reply, cost } = await this.ai.llm().generateText(
      {
        role: 'qa',
        system:
          'You write short, warm replies to Google Business Profile customer reviews on ' +
          "behalf of a business, in the brand's own voice. Thank the reviewer and address " +
          'what they actually said — praise or a specific complaint — without inventing ' +
          'any detail about an order, product, or interaction the review itself did not ' +
          'mention. 2-4 sentences. No sign-off, no placeholder brackets: return text ready ' +
          'to post as-is.',
        messages: [
          {
            role: 'user',
            content: [
              '**The brand:**',
              ...renderBrandContextLines(context),
              '',
              `**Review (${review.rating}/5 stars) from ${review.reviewerName}:**`,
              review.reviewText,
            ].join('\n'),
          },
        ],
        maxTokens: MAX_REVIEW_REPLY_TOKENS,
      },
      { brandId: review.brandId, referenceId },
    );

    await this.db.insert(schema.costEvents).values({
      brandId: review.brandId,
      system: 'content',
      referenceId,
      provider: cost.provider,
      model: cost.model,
      operation: 'google-review-reply-draft',
      inputTokens: cost.inputTokens ?? null,
      outputTokens: cost.outputTokens ?? null,
      cachedInputTokens: cost.cachedInputTokens ?? null,
      imageCount: cost.imageCount ?? null,
      costMicroUsd: cost.costMicroUsd,
      latencyMs: cost.latencyMs ?? null,
    });

    const [updated] = await this.db
      .update(schema.googleReviews)
      .set({ draftReply: reply.trim(), status: 'approved', updatedAt: new Date() })
      .where(eq(schema.googleReviews.id, review.id))
      .returning();
    if (!updated) throw new Error('Update returned no row');
    return updated;
  }
}
