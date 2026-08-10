import {
  and,
  eq,
  getPublishingContext,
  inArray,
  recordContextSnapshot,
  schema,
  type Database,
} from '@bmas/db';
import type { ScheduledPostPublishJob } from '@bmas/shared';
import jwt from 'jsonwebtoken';
import type { WorkerContext } from '../context.js';
import { sendExpoPush } from './scheduled-post-hooks.js';

/** Mints a token for the post's actual owner rather than a fixed dev id, so
 *  the call passes content-api's JwtAuthGuard as whichever user owns this
 *  brand — required now that `/social/post` is authenticated per-user. Short
 *  TTL: this token only needs to survive the one fetch below. */
function mintServiceToken(ctx: WorkerContext, ownerId: string): string {
  return jwt.sign({ sub: ownerId }, ctx.authSecret, { expiresIn: '5m' });
}

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
 * The claim failed, so this job is not publishing anything. It still owes the
 * user an answer when the reason is that they never reviewed it in time:
 * publishing it now without a review would defeat the approval gate, so the
 * slot is marked as missed instead.
 *
 * Any other status — already posted, rejected, failed, or currently being
 * published by whoever won the claim — is somebody else's business.
 */
async function expireIfUnreviewed(ctx: WorkerContext, scheduledPostId: string): Promise<void> {
  const [expired] = await ctx.db
    .update(schema.scheduledPosts)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(schema.scheduledPosts.id, scheduledPostId),
        inArray(schema.scheduledPosts.status, ['pending_generation', 'pending_approval']),
      ),
    )
    .returning();
  if (!expired) return;

  await notifyOwner(ctx.db, expired.brandId, {
    title: 'A scheduled post was skipped',
    body: 'Its publish time arrived before you approved it, so it was not posted.',
    data: { scheduledPostId: expired.id },
  });
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
  // Claim the row rather than reading it and deciding: a single conditional
  // UPDATE is atomic, so of two workers racing the same job only one sees a
  // returned row and the other stops here. Reading first and checking the
  // status in JS left the whole Instagram call inside the gap between the two,
  // and BullMQ redelivers a job whose lock expires (maxStalledCount defaults
  // to 1) — which is exactly how the same creative gets published twice.
  const [post] = await ctx.db
    .update(schema.scheduledPosts)
    .set({ status: 'publishing', updatedAt: new Date() })
    .where(
      and(
        eq(schema.scheduledPosts.id, job.scheduledPostId),
        eq(schema.scheduledPosts.status, 'approved'),
      ),
    )
    .returning();

  if (!post) {
    // Not ours to publish. Either another worker holds it, or it was never
    // approved — the latter still needs expiring, so look at why.
    await expireIfUnreviewed(ctx, job.scheduledPostId);
    return;
  }

  // Publishing context (Rule 8): what the automation policy was at the moment
  // this went out, and which accounts were connected. Credential-free by
  // construction — `getPublishingContext` never selects the encrypted token —
  // so this is safe to snapshot. The actual token is still fetched by the
  // `/social/post` endpoint below, which owns decryption.
  const publishing = await getPublishingContext(ctx.db, post.brandId).catch(() => null);
  if (publishing) {
    await recordContextSnapshot(ctx.db, {
      brandId: post.brandId,
      agentType: 'publishing',
      snapshot: { ...publishing, scheduledPostId: post.id },
    });
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

  // Split deliberately: only a failure *before* Meta accepted the post may mark
  // the row 'failed'. Once it is live, saying "failed" invites the user to
  // retry and post the same creative a second time — so a book-keeping failure
  // after a successful publish leaves the row in 'publishing' for a human to
  // resolve, which is at least honest about not knowing.
  let igMediaId: string;
  try {
    const [owner] = await ctx.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, post.brandId))
      .limit(1);
    if (!owner) throw new Error(`Brand ${post.brandId} not found`);

    const response = await fetch(`${ctx.contentApiUrl}/social/post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mintServiceToken(ctx, owner.ownerId)}`,
      },
      body: JSON.stringify({
        accountId: post.accountId,
        assetId: post.selectedAssetId,
        caption: post.caption,
      }),
    });
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error((body as { message?: string } | null)?.message ?? `HTTP ${response.status}`);
    }

    const postId = (body as { postId?: unknown } | null)?.postId;
    if (typeof postId !== 'string' || postId.length === 0) {
      // A 2xx with no media id: content-api reached Meta but we cannot prove
      // what happened, so this is the ambiguous case, not a clean failure.
      console.error(
        `[scheduled-post-publish] ${post.id}: content-api returned success with no postId; ` +
          'leaving the row in publishing for manual review',
      );
      return;
    }
    igMediaId = postId;
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
    return;
  }

  await ctx.db
    .update(schema.scheduledPosts)
    .set({ status: 'posted', igMediaId, error: null, updatedAt: new Date() })
    .where(eq(schema.scheduledPosts.id, post.id));

  await notifyOwner(ctx.db, post.brandId, {
    title: 'Your post is live',
    body: 'A scheduled post just published to Instagram.',
    data: { scheduledPostId: post.id },
  });
}
