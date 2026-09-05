import { and, eq, schema, type Database } from '@bmas/db';
import { notifyBrandOwner } from './push.js';

/** Instagram's hard limit on a caption. Meta rejects the whole post over this,
 *  so it is a publish-time failure rather than a truncation on their side. */
const INSTAGRAM_CAPTION_LIMIT = 2200;

/**
 * Builds the caption from a copy pack, using the same shape the manual posting
 * screen does: headline, body, hashtags, CTA.
 *
 * Each field is individually capped at 2200 upstream, but nothing bounded their
 * *sum* — four fields near their own limits compose a caption Meta refuses.
 *
 * When it does not fit, hashtags go first and the CTA is kept: a post that
 * still asks for the click is worth more than one that is merely discoverable.
 * The hard slice at the end is a backstop for copy that overruns on the
 * headline and body alone.
 */
export function composeCaption(copy: {
  headline: string;
  caption: string;
  hashtags: string[];
  cta: string;
}): string {
  const present = (value: string): boolean => value.trim().length > 0;
  const hashtags = copy.hashtags.join(' ');

  const candidates = [
    [copy.headline, copy.caption, hashtags, copy.cta],
    // Drop hashtags before the CTA.
    [copy.headline, copy.caption, copy.cta],
    [copy.headline, copy.caption],
  ];

  for (const sections of candidates) {
    const joined = sections.filter(present).join('\n\n');
    if (joined.length <= INSTAGRAM_CAPTION_LIMIT) return joined;
  }

  return [copy.headline, copy.caption]
    .filter(present)
    .join('\n\n')
    .slice(0, INSTAGRAM_CAPTION_LIMIT);
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
    // Without an explicit order Postgres may hand back a different account run
    // to run, so which one a post defaults to would drift for no visible reason.
    // Oldest connection wins, which is the one a user thinks of as their main.
    .orderBy(schema.socialAccounts.connectedAt)
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

  // Ordered so "the first asset" and "the first copy pack" mean the same row on
  // every run; an unordered select leaves both to Postgres's discretion.
  const [assets, copyPacks, brand, product] = await Promise.all([
    db
      .select()
      .from(schema.creativeAssets)
      .where(eq(schema.creativeAssets.jobId, jobId))
      .orderBy(schema.creativeAssets.createdAt),
    db
      .select()
      .from(schema.copyPacks)
      .where(eq(schema.copyPacks.jobId, jobId))
      .orderBy(schema.copyPacks.createdAt),
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
  const caption = composeCaption(copy);

  // Conditional on still being 'pending_generation'. Cancelling a campaign
  // rejects its posts but cannot un-queue work already running, so without this
  // a generation finishing afterwards would flip a rejected post back to
  // 'pending_approval' and notify the user about a campaign they cancelled --
  // and approving that post would then do nothing, because its publish job is
  // already gone.
  const [updated] = await db
    .update(schema.scheduledPosts)
    .set({
      status: 'pending_approval',
      selectedAssetId: asset.id,
      accountId,
      caption,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.scheduledPosts.id, post.id),
        eq(schema.scheduledPosts.status, 'pending_generation'),
      ),
    )
    .returning();
  if (!updated) return;

  await notifyBrandOwner(db, post.brandId, {
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

  // Same guard as the success path: a cancelled or already-rejected post must
  // not be dragged back into 'failed' and re-notified.
  const [updated] = await db
    .update(schema.scheduledPosts)
    .set({ status: 'failed', error: errorMessage, updatedAt: new Date() })
    .where(
      and(
        eq(schema.scheduledPosts.id, post.id),
        eq(schema.scheduledPosts.status, 'pending_generation'),
      ),
    )
    .returning();
  if (!updated) return;

  await notifyBrandOwner(db, post.brandId, {
    title: 'A scheduled post failed to generate',
    body: 'Tap to review and regenerate it before its time slot passes.',
    data: { scheduledPostId: post.id },
  });
}
