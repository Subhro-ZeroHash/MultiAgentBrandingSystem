import { and, eq, schema, type Database } from '@bmas/db';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Fire-and-forget by design: a push failing to send must never fail the
 * generation job that triggered it, and there is no receipt-tracking UI to
 * feed a retry into. `tokens` is typically 0 or 1 entries in this single-user
 * dev setup, but the endpoint accepts a batch either way.
 */
async function sendExpoPush(
  tokens: string[],
  message: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  if (tokens.length === 0) return;

  try {
    await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          sound: 'default',
          ...(message.data ? { data: message.data } : {}),
        })),
      ),
    });
  } catch (error) {
    console.error('[scheduled-post] failed to send push notification:', error);
  }
}

async function pushTokensForOwner(db: Database, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ token: schema.pushTokens.expoPushToken })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.ownerId, ownerId));
  return rows.map((row) => row.token);
}

/** The Instagram account this scheduled post defaults to, so the approval
 *  screen never shows an empty account picker when exactly one is connected.
 *  The user can still change it before approving. */
async function defaultInstagramAccountId(db: Database, ownerId: string): Promise<string | null> {
  const [account] = await db
    .select({ id: schema.socialAccounts.id })
    .from(schema.socialAccounts)
    .where(
      and(
        eq(schema.socialAccounts.ownerId, ownerId),
        eq(schema.socialAccounts.platform, 'instagram'),
        eq(schema.socialAccounts.status, 'active'),
      ),
    )
    .limit(1);
  return account?.id ?? null;
}

/**
 * Runs after a generation job succeeds. A no-op for the ordinary one-shot
 * generation flow (`scheduled_posts` has no row referencing most jobs) — only
 * jobs created by `SchedulingService.createCampaign` are found here.
 *
 * Picks sensible defaults (first QA-passed asset, first copy pack, the
 * brand's connected Instagram account) so the approval screen has something
 * to show immediately; all three are still editable by the user before they
 * approve.
 */
export async function onGenerationSucceeded(db: Database, jobId: string): Promise<void> {
  const [post] = await db
    .select()
    .from(schema.scheduledPosts)
    .where(eq(schema.scheduledPosts.generationJobId, jobId))
    .limit(1);
  if (!post) return;

  const [assets, copyPacks, brand, product] = await Promise.all([
    db.select().from(schema.creativeAssets).where(eq(schema.creativeAssets.jobId, jobId)),
    db.select().from(schema.copyPacks).where(eq(schema.copyPacks.jobId, jobId)),
    db.select().from(schema.brands).where(eq(schema.brands.id, post.brandId)).limit(1),
    db.select().from(schema.products).where(eq(schema.products.id, post.productId)).limit(1),
  ]);

  const asset =
    assets.find((candidate) => (candidate.qaResult as { passed?: boolean } | null)?.passed) ??
    assets[0];
  const copy = copyPacks[0];
  const ownerId = brand[0]?.ownerId;
  const productName = product[0]?.name ?? 'your product';

  if (!asset || !copy || !ownerId) {
    // Generation "succeeded" but produced nothing usable — treat it the same
    // as a failure so the user is told rather than left with a silently stuck
    // 'pending_generation' row.
    await onGenerationFailed(db, jobId, 'Generation completed with no usable image or caption.');
    return;
  }

  const accountId = await defaultInstagramAccountId(db, ownerId);
  const caption = `${copy.headline}\n\n${copy.caption}\n\n${copy.hashtags.join(' ')}\n\n${copy.cta}`;

  await db
    .update(schema.scheduledPosts)
    .set({
      status: 'pending_approval',
      selectedAssetId: asset.id,
      accountId,
      caption,
      updatedAt: new Date(),
    })
    .where(eq(schema.scheduledPosts.id, post.id));

  await sendExpoPush(await pushTokensForOwner(db, ownerId), {
    title: 'A post is ready to review',
    body: `Your post for ${productName} is ready — review it before it goes out.`,
    data: { scheduledPostId: post.id },
  });
}

/** Runs when a generation job that a scheduled post depends on fails
 *  terminally (permanent failure, or retries exhausted). No-op for ordinary
 *  one-shot generations, same as `onGenerationSucceeded`. */
export async function onGenerationFailed(
  db: Database,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const [post] = await db
    .select()
    .from(schema.scheduledPosts)
    .where(eq(schema.scheduledPosts.generationJobId, jobId))
    .limit(1);
  if (!post) return;

  await db
    .update(schema.scheduledPosts)
    .set({ status: 'failed', error: errorMessage, updatedAt: new Date() })
    .where(eq(schema.scheduledPosts.id, post.id));

  const [brand] = await db
    .select({ ownerId: schema.brands.ownerId })
    .from(schema.brands)
    .where(eq(schema.brands.id, post.brandId))
    .limit(1);
  if (!brand) return;

  await sendExpoPush(await pushTokensForOwner(db, brand.ownerId), {
    title: 'A scheduled post failed to generate',
    body: 'Tap to review and regenerate it before its time slot passes.',
    data: { scheduledPostId: post.id },
  });
}

export { sendExpoPush };
