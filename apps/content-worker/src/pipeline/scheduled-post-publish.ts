import { eq, schema, type Database } from '@bmas/db';
import type { ScheduledPostPublishJob } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { sendExpoPush } from './scheduled-post-hooks.js';

async function notifyOwner(
  db: Database,
  brandId: string,
  message: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  const [brand] = await db
    .select({ ownerId: schema.brands.ownerId })
    .from(schema.brands)
    .where(eq(schema.brands.id, brandId))
    .limit(1);
  if (!brand) return;

  const tokens = await db
    .select({ token: schema.pushTokens.expoPushToken })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.ownerId, brand.ownerId));

  await sendExpoPush(
    tokens.map((row) => row.token),
    message,
  );
}

/**
 * Fires at a scheduled post's publish time. Always re-reads the row's current
 * status rather than trusting anything captured when the job was queued
 * (hours or days earlier) — the user may never have approved it, or may have
 * cancelled the whole campaign, and the row is the only source of truth for
 * either.
 *
 * Publishing itself is a single HTTP call to content-api's existing
 * `POST /social/post` — the same request `post.tsx` already makes — so the
 * container-create/poll/publish logic in `SocialService` is reused exactly,
 * not duplicated here.
 */
export async function runScheduledPostPublish(
  ctx: WorkerContext,
  job: ScheduledPostPublishJob,
): Promise<void> {
  const [post] = await ctx.db
    .select()
    .from(schema.scheduledPosts)
    .where(eq(schema.scheduledPosts.id, job.scheduledPostId))
    .limit(1);
  if (!post) return; // Row is gone (should not happen); nothing to publish.

  if (post.status !== 'approved') {
    // Still pending: the user never reviewed it in time, or generation itself
    // never finished. Either way its moment has passed — publishing it now
    // without a review would defeat the entire point of the approval gate.
    if (post.status === 'pending_generation' || post.status === 'pending_approval') {
      await ctx.db
        .update(schema.scheduledPosts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(schema.scheduledPosts.id, post.id));

      await notifyOwner(ctx.db, post.brandId, {
        title: 'A scheduled post was skipped',
        body: 'Its publish time arrived before you approved it, so it was not posted.',
        data: { scheduledPostId: post.id },
      });
    }
    // Already 'rejected', 'failed', or 'posted' — nothing to do.
    return;
  }

  if (!post.accountId || !post.selectedAssetId || !post.caption) {
    await ctx.db
      .update(schema.scheduledPosts)
      .set({
        status: 'failed',
        error: 'Approved but missing an account, image, or caption at publish time.',
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledPosts.id, post.id));

    await notifyOwner(ctx.db, post.brandId, {
      title: 'A scheduled post failed to publish',
      body: 'It was approved but was missing required details when its time came.',
      data: { scheduledPostId: post.id },
    });
    return;
  }

  try {
    const response = await fetch(`${ctx.contentApiUrl}/social/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': ctx.devOwnerId },
      body: JSON.stringify({
        accountId: post.accountId,
        assetId: post.selectedAssetId,
        caption: post.caption,
      }),
    });
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const message = (body as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      throw new Error(message);
    }

    const result = body as { postId: string; success: boolean };
    await ctx.db
      .update(schema.scheduledPosts)
      .set({ status: 'posted', igMediaId: result.postId, error: null, updatedAt: new Date() })
      .where(eq(schema.scheduledPosts.id, post.id));

    await notifyOwner(ctx.db, post.brandId, {
      title: 'Your post is live',
      body: 'A scheduled post just published to Instagram.',
      data: { scheduledPostId: post.id },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[scheduled-post-publish] ${post.id} failed to publish: ${message}`);

    await ctx.db
      .update(schema.scheduledPosts)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.scheduledPosts.id, post.id));

    await notifyOwner(ctx.db, post.brandId, {
      title: 'A scheduled post failed to publish',
      body: message.slice(0, 120),
      data: { scheduledPostId: post.id },
    });
  }
}
