import { describeError } from '@bmas/ai';
import { and, eq, gte, isNotNull, schema, type SocialAccount } from '@bmas/db';
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
 * Instagram post-performance sync.
 *
 * Sweeps recently-published posts and pulls fresh engagement numbers from the
 * Instagram Graph API, storing every attempt (success or failure) as its own
 * row — same "raw log, never overwritten" shape as geo.probe_runs, and for the
 * same reason: a failed pull is data (the account's token expired, the media
 * was deleted) rather than a silent gap, and repeated pulls over a post's
 * tracked life show its engagement curve rather than just a final number.
 *
 * Lives in content-worker, not content-api, mirroring the GEO probe worker's
 * pattern rather than scheduled-post-publish.ts's worker-calls-API pattern:
 * this is a read sweeping many posts across many owners in one tick, not a
 * single stateful write on behalf of one user, so there is no single owner to
 * mint a service token for. TokenEncryption and the Graph error-parsing
 * helpers moved to @bmas/shared, both for the same reason: content-api's
 * SocialService already had them, and this file needs the identical logic
 * without a second copy that can silently drift from the original.
 */

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

type GraphResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * GET against the Graph API. Returns a result rather than throwing, so a
 * caller can decide whether a failure here is fatal to the whole fetch or
 * just one field group — mirrors social.service.ts's private `graphGet`.
 *
 * `body === null` (a 200 with an empty or unparseable response) is treated as
 * a failure explicitly, not just checked via `isGraphErrorPayload`: that function
 * only looks for an `error` key, so a null body — which has no keys at all —
 * would otherwise read as "not an error" and be cast into the caller's
 * expected shape, producing a null-property-access crash instead of a clear
 * "could not X" message.
 */
async function graphGet(path: string, params: Record<string, string>): Promise<GraphResult> {
  const response = await fetch(`${GRAPH_BASE}/${path}?${new URLSearchParams(params).toString()}`);
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || body === null || typeof body !== 'object' || isGraphErrorPayload(body)) {
    return { ok: false, message: graphErrorMessage(body, `HTTP ${response.status}`) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

interface FetchedMetrics {
  likeCount: number | null;
  commentsCount: number | null;
  reach: number | null;
  saved: number | null;
  raw: Record<string, unknown>;
}

/** Two calls, fetched concurrently since neither depends on the other's
 *  result — both only need igMediaId and accessToken, known up front. Each is
 *  parsed independently: a media type Graph doesn't compute `saved` for must
 *  not lose the like/comment counts that succeeded, and vice versa. */
async function fetchMediaMetrics(igMediaId: string, accessToken: string): Promise<FetchedMetrics> {
  const [fieldsResult, insightsResult] = await Promise.all([
    graphGet(igMediaId, { fields: 'like_count,comments_count', access_token: accessToken }),
    graphGet(`${igMediaId}/insights`, { metric: 'reach,saved', access_token: accessToken }),
  ]);

  if (!fieldsResult.ok) {
    throw new Error(`could not read post fields — ${fieldsResult.message}`);
  }

  const byName = new Map<string, number>();
  if (insightsResult.ok) {
    const data = insightsResult.body.data;
    if (Array.isArray(data)) {
      for (const metric of data as unknown[]) {
        const name = (metric as { name?: unknown }).name;
        const value = (metric as { values?: Array<{ value?: unknown }> }).values?.[0]?.value;
        if (typeof name === 'string' && typeof value === 'number') byName.set(name, value);
      }
    }
  }

  return {
    likeCount: (fieldsResult.body.like_count as number | undefined) ?? null,
    commentsCount: (fieldsResult.body.comments_count as number | undefined) ?? null,
    reach: byName.get('reach') ?? null,
    saved: byName.get('saved') ?? null,
    raw: {
      fields: fieldsResult.body,
      // Insights failing is not fatal to the whole fetch — recorded in `raw`
      // rather than dropped, so a media type that rejects these metrics is
      // still visible in the log instead of looking like a clean success.
      insights: insightsResult.ok ? insightsResult.body : { error: insightsResult.message },
    },
  };
}

interface EligiblePost {
  scheduledPostId: string;
  brandId: string;
  igMediaId: string;
  account: SocialAccount;
}

async function getEligiblePosts(ctx: WorkerContext): Promise<EligiblePost[]> {
  const cutoff = new Date(Date.now() - INSTAGRAM_INSIGHTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await ctx.db
    .select({
      scheduledPostId: schema.scheduledPosts.id,
      brandId: schema.scheduledPosts.brandId,
      igMediaId: schema.scheduledPosts.igMediaId,
      account: schema.socialAccounts,
    })
    .from(schema.scheduledPosts)
    .innerJoin(schema.socialAccounts, eq(schema.scheduledPosts.accountId, schema.socialAccounts.id))
    .where(
      and(
        eq(schema.scheduledPosts.status, 'posted'),
        // A disconnected/revoked account has no business being re-attempted
        // every tick for its whole lookback window — matches the convention
        // scheduled-post-hooks.ts already uses for the same table.
        eq(schema.socialAccounts.status, 'active'),
        isNotNull(schema.scheduledPosts.igMediaId),
        gte(schema.scheduledPosts.updatedAt, cutoff),
      ),
    );

  // The type predicate below is what actually narrows igMediaId from
  // `string | null` to `string` for every row that survives — isNotNull() in
  // the WHERE clause guarantees it holds, TypeScript just can't see through a
  // runtime SQL clause to know that.
  return rows.filter((row): row is EligiblePost => row.igMediaId !== null);
}

/** Resume rather than restart, same reasoning as geo-worker's probe.ts
 *  (`findRunInBucket`): BullMQ redelivers a job whose lock expires mid-run,
 *  and without this check a redelivered tick would produce a second
 *  near-identical row for the same post inside the same sync window — which
 *  reads as a real distinct engagement sample to anything consuming this
 *  table later, not as a redelivery artifact. Unlike probe.ts this isn't
 *  about avoiding a double-billed paid call (Instagram's Insights API is
 *  free); it protects the append-only log's own meaning. */
async function alreadySyncedThisWindow(
  ctx: WorkerContext,
  scheduledPostId: string,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS * 3_600_000);
  const [existing] = await ctx.db
    .select({ id: schema.postInsights.id })
    .from(schema.postInsights)
    .where(
      and(
        eq(schema.postInsights.scheduledPostId, scheduledPostId),
        gte(schema.postInsights.fetchedAt, windowStart),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

async function recordFailure(
  ctx: WorkerContext,
  post: EligiblePost,
  error: string,
): Promise<void> {
  await ctx.db.insert(schema.postInsights).values({
    scheduledPostId: post.scheduledPostId,
    brandId: post.brandId,
    error,
  });
}

async function syncOnePost(
  ctx: WorkerContext,
  encryption: TokenEncryption | null,
  post: EligiblePost,
): Promise<void> {
  if (await alreadySyncedThisWindow(ctx, post.scheduledPostId)) return;

  const { account } = post;

  // Same signal SocialService.postToInstagram writes on the same condition —
  // a token expiring is discovered by whichever job touches the account
  // first, publish or sync, and both should leave it in the same state.
  if (isTokenExpired(account.tokenExpiresAt)) {
    await ctx.db
      .update(schema.socialAccounts)
      .set({ status: 'token_expired' as const })
      .where(eq(schema.socialAccounts.id, account.id));
    await recordFailure(ctx, post, `Instagram token for ${account.displayName} has expired.`);
    return;
  }

  let accessToken: string;
  try {
    accessToken = encryption ? encryption.decrypt(account.pageAccessToken) : account.pageAccessToken;
  } catch (error) {
    await recordFailure(ctx, post, `Stored token could not be decrypted: ${describeError(error)}`);
    return;
  }

  try {
    const metrics = await fetchMediaMetrics(post.igMediaId, accessToken);
    await ctx.db.insert(schema.postInsights).values({
      scheduledPostId: post.scheduledPostId,
      brandId: post.brandId,
      likeCount: metrics.likeCount,
      commentsCount: metrics.commentsCount,
      reach: metrics.reach,
      saved: metrics.saved,
      raw: metrics.raw,
    });
  } catch (error) {
    // A failed pull is still recorded — see the module comment on why this
    // mirrors probe_runs rather than being dropped.
    await recordFailure(ctx, post, describeError(error));
  }
}

/** The tick's processor: find who's due, sync each, log what happened. One
 *  post failing (a revoked token, a deleted media) is recorded and skipped
 *  rather than aborting the sweep — the other posts still deserve their sync
 *  this round. */
export async function runInstagramInsightsSync(ctx: WorkerContext): Promise<void> {
  const posts = await getEligiblePosts(ctx);

  if (posts.length === 0) {
    console.warn('[instagram-insights-sync] tick: no posts due');
    return;
  }

  console.warn(`[instagram-insights-sync] tick: ${posts.length} post(s) due`);

  const encryption = ctx.encryptionKey ? new TokenEncryption(ctx.encryptionKey) : null;

  for (const post of posts) {
    try {
      await syncOnePost(ctx, encryption, post);
    } catch (error) {
      console.error(
        `[instagram-insights-sync] failed to sync post ${post.scheduledPostId}: ${describeError(error)}`,
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
