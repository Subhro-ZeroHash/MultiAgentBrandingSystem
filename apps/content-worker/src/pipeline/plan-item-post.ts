import { and, eq, gte, isNotNull, schema, type Database } from '@bmas/db';
import { QUEUES, computeScheduleSlots } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { onGenerationSucceeded } from './scheduled-post-hooks.js';

/**
 * Turns an approved plan item's finished creative into a real scheduled post.
 *
 * Approving a plan item only starts a generation (PlanningService.approveItem),
 * so without this the item sat at 'generating' forever: the poster existed in
 * the library, but nothing put it in the approval queue or on the calendar for
 * the day the plan picked. This gives it the same single-post
 * scheduled_campaign / scheduled_posts pair the trend autopilot uses
 * (opportunity-trigger.ts), on the item's planned day, and then runs the
 * ordinary success hook — so it lands in 'pending_approval' with its image and
 * caption picked, and publishes only if the owner approves it before the slot
 * (an unapproved post expires instead).
 *
 * Idempotent and a no-op for anything that is not an approved plan item whose
 * generation succeeded, so it is safe to call after every generation and from
 * the startup sweep below.
 */
export async function schedulePlanItemPost(
  db: Database,
  publishQueue: Queue,
  generationJobId: string,
): Promise<void> {
  const [item] = await db
    .select()
    .from(schema.planItems)
    .where(
      and(
        eq(schema.planItems.generationJobId, generationJobId),
        eq(schema.planItems.status, 'generating'),
      ),
    )
    .limit(1);
  if (!item?.productId) return;

  const [job] = await db
    .select({ status: schema.generationJobs.status })
    .from(schema.generationJobs)
    .where(eq(schema.generationJobs.id, generationJobId))
    .limit(1);
  if (job?.status !== 'succeeded') return;

  const [existing] = await db
    .select({ id: schema.scheduledPosts.id })
    .from(schema.scheduledPosts)
    .where(eq(schema.scheduledPosts.generationJobId, generationJobId))
    .limit(1);
  if (existing) return;

  // The plan's day, at the same publish time a one-day campaign would get; a
  // day already too close (or past) rolls to the next open slot.
  const now = new Date();
  const [scheduledFor] = computeScheduleSlots({
    startAt: item.plannedFor ?? now,
    totalDays: 1,
    postsPerDay: 1,
    now,
  });
  if (!scheduledFor) return;

  const request = item.suggestedRequest;
  const [campaign] = await db
    .insert(schema.scheduledCampaigns)
    .values({
      brandId: item.brandId,
      productId: item.productId,
      campaignType: request.campaignType,
      styleTemplate: request.styleTemplate,
      outputFormat: request.outputFormat,
      totalDays: 1,
      postsPerDay: 1,
      startAt: scheduledFor,
    })
    .returning();
  if (!campaign) throw new Error(`Failed to insert a campaign for plan item ${item.id}`);

  try {
    const [post] = await db
      .insert(schema.scheduledPosts)
      .values({
        campaignId: campaign.id,
        brandId: item.brandId,
        productId: item.productId,
        scheduledFor,
        generationJobId,
      })
      .returning();
    if (!post) throw new Error(`Failed to insert a scheduled post for plan item ${item.id}`);

    // Same deterministic job id as SchedulingService.enqueuePublish, so
    // cancelling the post from the app finds this job.
    await publishQueue.add(
      QUEUES.scheduledPostPublish,
      { scheduledPostId: post.id },
      {
        jobId: post.id,
        delay: Math.max(0, scheduledFor.getTime() - now.getTime()),
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  } catch (error) {
    // Posts cascade with their campaign; a post with no publish job would sit
    // in the queue looking scheduled and never go out.
    await db.delete(schema.scheduledCampaigns).where(eq(schema.scheduledCampaigns.id, campaign.id));
    throw error;
  }

  await db
    .update(schema.planItems)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(eq(schema.planItems.id, item.id));

  await onGenerationSucceeded(db, generationJobId);
  console.warn(`[plan-item-post] plan item ${item.id} scheduled for ${scheduledFor.toISOString()}`);
}

/**
 * Startup sweep for plan items approved before schedulePlanItemPost existed
 * (or whose generation finished while the worker was down). Only items whose
 * planned day is today or later: an old plan's idea surfacing for approval
 * weeks after its moment would be noise, not help.
 */
export async function schedulePendingPlanItemPosts(db: Database, publishQueue: Queue) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const items = await db
    .select({ generationJobId: schema.planItems.generationJobId })
    .from(schema.planItems)
    .where(
      and(
        eq(schema.planItems.status, 'generating'),
        isNotNull(schema.planItems.generationJobId),
        gte(schema.planItems.plannedFor, today),
      ),
    );
  for (const { generationJobId } of items) {
    if (generationJobId) await schedulePlanItemPost(db, publishQueue, generationJobId);
  }
}
