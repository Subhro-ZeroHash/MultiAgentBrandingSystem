import { describeError } from '@bmas/ai';
import { and, eq, gte, inArray, isNotNull, schema, sql, type SocialAccount } from '@bmas/db';
import {
  graphErrorMessage,
  INSTAGRAM_INSIGHTS_LOOKBACK_DAYS,
  INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS,
  isGraphErrorPayload,
  isTokenExpired,
  QUEUES,
  TokenEncryption,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';

/**
 * Instagram post-performance and community-response sync.
 *
 * Sweeps every post on each connected account and pulls fresh engagement
 * numbers plus the comments left on them, storing each attempt (success or
 * failure) as its own row — same "raw log, never overwritten" shape as
 * geo.probe_runs, and for the same reason: a failed pull is data (the token
 * expired, the media was deleted) rather than a silent gap, and repeated pulls
 * over a post's life show its engagement curve rather than just a final
 * number.
 *
 * Sweeps the *account*, not just posts this app published. The original
 * version joined scheduled_posts and so only ever saw app-published content;
 * for a brand that posts from the Instagram app that set is empty, which left
 * the whole feedback loop with nothing to learn from. Media that does trace
 * back to a scheduled post is still linked, so post-level feedback can be
 * attributed to the campaign that produced it.
 *
 * Lives in content-worker, not content-api, mirroring the GEO probe worker's
 * pattern rather than scheduled-post-publish.ts's worker-calls-API pattern:
 * this is a read sweeping many posts across many owners in one tick, not a
 * single stateful write on behalf of one user, so there is no single owner to
 * mint a service token for.
 */

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

/** How many of an account's most recent posts one tick looks at. Instagram
 *  pages `me/media`; this is a deliberate ceiling on a single sweep rather
 *  than a claim the account has no more posts than this. */
const MEDIA_PAGE_SIZE = 50;

/** Comments read per post per tick, newest first. */
const COMMENTS_PAGE_SIZE = 50;

type GraphResult = { ok: true; body: Record<string, unknown> } | { ok: false; message: string };

/**
 * GET against the Graph API. Returns a result rather than throwing, so a
 * caller can decide whether a failure here is fatal to the whole fetch or
 * just one field group — mirrors social.service.ts's private `graphGet`.
 *
 * `body === null` (a 200 with an empty or unparseable response) is treated as
 * a failure explicitly, not just checked via `isGraphErrorPayload`: that
 * function only looks for an `error` key, so a null body — which has no keys
 * at all — would otherwise read as "not an error" and be cast into the
 * caller's expected shape, producing a null-property-access crash instead of
 * a clear "could not X" message.
 */
async function graphGet(path: string, params: Record<string, string>): Promise<GraphResult> {
  const response = await fetch(`${GRAPH_BASE}/${path}?${new URLSearchParams(params).toString()}`);
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || body === null || typeof body !== 'object' || isGraphErrorPayload(body)) {
    return { ok: false, message: graphErrorMessage(body, `HTTP ${response.status}`) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

interface MediaSummary {
  id: string;
  caption: string | null;
  permalink: string | null;
  mediaType: string | null;
  postedAt: Date | null;
  likeCount: number | null;
  commentsCount: number | null;
  raw: Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Instagram timestamps are ISO-8601 with a +0000 offset; anything
 *  unparseable becomes null rather than an Invalid Date the DB would reject. */
function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The account's recent posts, with the engagement counts that come free on
 *  the media object itself — no `manage_insights` grant needed for these. */
async function fetchAccountMedia(accessToken: string): Promise<MediaSummary[]> {
  const result = await graphGet('me/media', {
    fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
    limit: String(MEDIA_PAGE_SIZE),
    access_token: accessToken,
  });
  if (!result.ok) throw new Error(`could not list account media — ${result.message}`);

  const data = result.body.data;
  if (!Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>)
    .filter((item): item is Record<string, unknown> => typeof item?.id === 'string')
    .map((item) => ({
      id: item.id as string,
      caption: toText(item.caption),
      permalink: toText(item.permalink),
      mediaType: toText(item.media_type),
      postedAt: toDate(item.timestamp),
      likeCount: toNumber(item.like_count),
      commentsCount: toNumber(item.comments_count),
      raw: item,
    }));
}

/**
 * Reach and saves for one post.
 *
 * Returns nulls rather than throwing when the grant is missing: these metrics
 * need `instagram_business_manage_insights`, and an account connected before
 * that scope was requested returns 403 here forever until it reconnects. That
 * is a known, recoverable state — not a reason to fail the sweep and lose the
 * like/comment counts and comments that did come back.
 */
async function fetchMediaInsights(
  igMediaId: string,
  accessToken: string,
): Promise<{ reach: number | null; saved: number | null; raw: unknown }> {
  const result = await graphGet(`${igMediaId}/insights`, {
    metric: 'reach,saved',
    access_token: accessToken,
  });
  if (!result.ok) return { reach: null, saved: null, raw: { error: result.message } };

  const byName = new Map<string, number>();
  const data = result.body.data;
  if (Array.isArray(data)) {
    for (const metric of data as unknown[]) {
      const name = (metric as { name?: unknown }).name;
      const value = (metric as { values?: Array<{ value?: unknown }> }).values?.[0]?.value;
      if (typeof name === 'string' && typeof value === 'number') byName.set(name, value);
    }
  }
  return { reach: byName.get('reach') ?? null, saved: byName.get('saved') ?? null, raw: result.body };
}

interface FetchedComment {
  igCommentId: string;
  text: string | null;
  username: string | null;
  likeCount: number | null;
  commentedAt: Date | null;
  raw: Record<string, unknown>;
}

/** Comments on one post. Readable on `instagram_business_basic` — no
 *  `manage_comments` grant is needed to read, only to reply or moderate. */
async function fetchMediaComments(
  igMediaId: string,
  accessToken: string,
): Promise<FetchedComment[]> {
  const result = await graphGet(`${igMediaId}/comments`, {
    fields: 'id,text,username,timestamp,like_count',
    limit: String(COMMENTS_PAGE_SIZE),
    access_token: accessToken,
  });
  if (!result.ok) return [];

  const data = result.body.data;
  if (!Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>)
    .filter((item) => typeof item?.id === 'string')
    .map((item) => ({
      igCommentId: item.id as string,
      text: toText(item.text),
      username: toText(item.username),
      likeCount: toNumber(item.like_count),
      commentedAt: toDate(item.timestamp),
      raw: item,
    }));
}

interface SyncTarget {
  account: SocialAccount;
  brandId: string;
}

/**
 * Which accounts to sweep, and which brand each one's posts belong to.
 *
 * `social_accounts` and `brands` both hang off the owning user rather than off
 * each other, so attribution is only unambiguous when the owner has exactly
 * one brand. With several, the account is skipped and says so: guessing which
 * brand a post belongs to would poison the very feedback the loop is built to
 * trust. Media that traces back to a scheduled post is attributed exactly, in
 * `syncOneMedia` — this is the fallback for everything posted outside the app.
 */
async function getSyncTargets(ctx: WorkerContext): Promise<SyncTarget[]> {
  const accounts = await ctx.db
    .select()
    .from(schema.socialAccounts)
    .where(
      and(
        eq(schema.socialAccounts.platform, 'instagram'),
        eq(schema.socialAccounts.status, 'active'),
        isNotNull(schema.socialAccounts.igBusinessId),
      ),
    );

  const targets: SyncTarget[] = [];
  for (const account of accounts) {
    const brands = await ctx.db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(eq(schema.brands.ownerId, account.ownerId));

    if (brands.length === 1) {
      targets.push({ account, brandId: brands[0]!.id });
      continue;
    }
    console.warn(
      `[instagram-insights-sync] skipping ${account.displayName}: owner has ${brands.length} brands, ` +
        'so posts made outside the app cannot be attributed to one of them unambiguously.',
    );
  }
  return targets;
}

/** Resume rather than restart, same reasoning as geo-worker's probe.ts
 *  (`findRunInBucket`): BullMQ redelivers a job whose lock expires mid-run,
 *  and without this check a redelivered tick would produce a second
 *  near-identical row for the same post inside the same sync window — which
 *  reads as a real distinct engagement sample to anything consuming this
 *  table later, not as a redelivery artifact. Keyed on the media id rather
 *  than the scheduled post, since most media has no scheduled post at all. */
async function alreadySyncedThisWindow(ctx: WorkerContext, igMediaId: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS * 3_600_000);
  const [existing] = await ctx.db
    .select({ id: schema.postInsights.id })
    .from(schema.postInsights)
    .where(
      and(
        eq(schema.postInsights.igMediaId, igMediaId),
        gte(schema.postInsights.fetchedAt, windowStart),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

/** Maps this account's media ids back to the scheduled posts that produced
 *  them, so app-published content keeps its campaign attribution. */
async function scheduledPostIdsByMedia(
  ctx: WorkerContext,
  igMediaIds: string[],
): Promise<Map<string, string>> {
  if (igMediaIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: schema.scheduledPosts.id, igMediaId: schema.scheduledPosts.igMediaId })
    .from(schema.scheduledPosts)
    .where(inArray(schema.scheduledPosts.igMediaId, igMediaIds));

  const map = new Map<string, string>();
  for (const row of rows) if (row.igMediaId) map.set(row.igMediaId, row.id);
  return map;
}

async function syncOneMedia(
  ctx: WorkerContext,
  target: SyncTarget,
  media: MediaSummary,
  accessToken: string,
  scheduledPostId: string | null,
): Promise<void> {
  if (await alreadySyncedThisWindow(ctx, media.id)) return;

  const insights = await fetchMediaInsights(media.id, accessToken);

  await ctx.db.insert(schema.postInsights).values({
    igMediaId: media.id,
    scheduledPostId,
    socialAccountId: target.account.id,
    brandId: target.brandId,
    likeCount: media.likeCount,
    commentsCount: media.commentsCount,
    reach: insights.reach,
    saved: insights.saved,
    caption: media.caption,
    permalink: media.permalink,
    mediaType: media.mediaType,
    postedAt: media.postedAt,
    raw: { fields: media.raw, insights: insights.raw },
  });

  const comments = await fetchMediaComments(media.id, accessToken);
  if (comments.length === 0) return;

  // Upserted rather than appended: a comment is one durable object whose like
  // count changes, unlike the metrics above where each sample is its own
  // observation. Re-running a sweep should refresh them, not duplicate them.
  await ctx.db
    .insert(schema.postComments)
    .values(
      comments.map((comment) => ({
        igCommentId: comment.igCommentId,
        igMediaId: media.id,
        brandId: target.brandId,
        socialAccountId: target.account.id,
        text: comment.text,
        username: comment.username,
        likeCount: comment.likeCount,
        commentedAt: comment.commentedAt,
        raw: comment.raw,
      })),
    )
    .onConflictDoUpdate({
      target: schema.postComments.igCommentId,
      set: {
        text: sql`excluded.text`,
        likeCount: sql`excluded.like_count`,
        fetchedAt: new Date(),
      },
    });
}

async function syncOneAccount(
  ctx: WorkerContext,
  encryption: TokenEncryption | null,
  target: SyncTarget,
): Promise<void> {
  const { account } = target;

  // Same signal SocialService.postToInstagram writes on the same condition —
  // a token expiring is discovered by whichever job touches the account
  // first, publish or sync, and both should leave it in the same state.
  if (isTokenExpired(account.tokenExpiresAt)) {
    await ctx.db
      .update(schema.socialAccounts)
      .set({ status: 'token_expired' as const })
      .where(eq(schema.socialAccounts.id, account.id));
    console.warn(
      `[instagram-insights-sync] ${account.displayName}: token expired, marked for reconnect`,
    );
    return;
  }

  let accessToken: string;
  try {
    accessToken = encryption ? encryption.decrypt(account.pageAccessToken) : account.pageAccessToken;
  } catch (error) {
    console.error(
      `[instagram-insights-sync] ${account.displayName}: stored token could not be decrypted — ${describeError(error)}`,
    );
    return;
  }

  const media = await fetchAccountMedia(accessToken);
  const cutoff = new Date(Date.now() - INSTAGRAM_INSIGHTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // A post with no usable timestamp is kept rather than dropped: not knowing
  // when it was posted is not evidence that it is old.
  const inWindow = media.filter((item) => !item.postedAt || item.postedAt >= cutoff);

  const linked = await scheduledPostIdsByMedia(
    ctx,
    inWindow.map((item) => item.id),
  );

  console.warn(
    `[instagram-insights-sync] ${account.displayName}: ${inWindow.length} post(s) in window ` +
      `(${media.length} fetched, ${linked.size} traced to a scheduled post)`,
  );

  for (const item of inWindow) {
    try {
      await syncOneMedia(ctx, target, item, accessToken, linked.get(item.id) ?? null);
    } catch (error) {
      // A failed pull is still recorded — see the module comment on why this
      // mirrors probe_runs rather than being dropped.
      await ctx.db.insert(schema.postInsights).values({
        igMediaId: item.id,
        socialAccountId: account.id,
        brandId: target.brandId,
        error: describeError(error),
      });
    }
  }
}

/** The tick's processor: find who's due, sync each, log what happened. One
 *  account failing (a revoked token, a rate limit) is logged and skipped
 *  rather than aborting the sweep — the other accounts still deserve their
 *  sync this round. */
export async function runInstagramInsightsSync(ctx: WorkerContext): Promise<void> {
  const targets = await getSyncTargets(ctx);

  if (targets.length === 0) {
    console.warn('[instagram-insights-sync] tick: no connected accounts to sync');
    return;
  }

  console.warn(`[instagram-insights-sync] tick: ${targets.length} account(s) due`);

  const encryption = ctx.encryptionKey ? new TokenEncryption(ctx.encryptionKey) : null;

  for (const target of targets) {
    try {
      await syncOneAccount(ctx, encryption, target);
    } catch (error) {
      console.error(
        `[instagram-insights-sync] failed to sync ${target.account.displayName}: ${describeError(error)}`,
      );
    }
  }
}

/** Registers the repeatable tick, idempotently — same pattern as
 *  scheduleResearchSchedulerTick: BullMQ dedupes repeatable jobs by their
 *  repeat key, so calling this on every process boot is safe. */
export async function scheduleInstagramInsightsSyncTick(schedulerQueue: Queue): Promise<void> {
  await schedulerQueue.add(
    QUEUES.instagramInsightsSync,
    {},
    {
      jobId: 'instagram-insights-sync-tick',
      repeat: { every: INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS * 3_600_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  );
}
