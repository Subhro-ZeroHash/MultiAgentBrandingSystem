import { describeError } from '@bmas/ai';
import { and, eq, gte, isNotNull, schema, type SocialAccount } from '@bmas/db';
import {
  INSTAGRAM_INSIGHTS_LOOKBACK_DAYS,
  INSTAGRAM_INSIGHTS_SYNC_INTERVAL_HOURS,
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
 * mint a service token for. TokenEncryption moved to @bmas/shared so this can
 * decrypt a stored token itself without duplicating security-sensitive code.
 */

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

interface GraphErrorResponse {
  error?: { message?: string };
}

function graphErrorMessage(body: unknown, fallback: string): string {
  return (body as GraphErrorResponse | null)?.error?.message ?? fallback;
}

function isErrorPayload(body: unknown): boolean {
  return Boolean((body as GraphErrorResponse | null)?.error);
}

interface MediaFields {
  like_count?: number;
  comments_count?: number;
}

interface InsightsResponse {
  data?: Array<{ name: string; values?: Array<{ value: number }> }>;
}

interface FetchedMetrics {
  likeCount: number | null;
  commentsCount: number | null;
  reach: number | null;
  saved: number | null;
  raw: Record<string, unknown>;
}

/** Two calls: basic fields carry like/comment counts, `/insights` carries
 *  reach and saves. Kept separate — and each parsed independently — because a
 *  media type that rejects one metric (e.g. a format Graph doesn't compute
 *  `saved` for) must not lose the fields that succeeded. */
async function fetchMediaMetrics(igMediaId: string, accessToken: string): Promise<FetchedMetrics> {
  const fieldsResponse = await fetch(
    `${GRAPH_BASE}/${igMediaId}?${new URLSearchParams({
      fields: 'like_count,comments_count',
      access_token: accessToken,
    }).toString()}`,
  );
  const fieldsBody: unknown = await fieldsResponse.json().catch(() => null);
  if (!fieldsResponse.ok || isErrorPayload(fieldsBody)) {
    throw new Error(
      `could not read post fields — ${graphErrorMessage(fieldsBody, `HTTP ${fieldsResponse.status}`)}`,
    );
  }
  const fields = fieldsBody as MediaFields;

  const insightsResponse = await fetch(
    `${GRAPH_BASE}/${igMediaId}/insights?${new URLSearchParams({
      metric: 'reach,saved',
      access_token: accessToken,
    }).toString()}`,
  );
  const insightsBody: unknown = await insightsResponse.json().catch(() => null);
  // Insights failing is not fatal to the whole fetch — like/comment counts
  // above are still worth keeping. A common cause is a media type Graph does
  // not compute these particular metrics for.
  const insightsOk = insightsResponse.ok && !isErrorPayload(insightsBody);
  const byName = new Map<string, number>();
  if (insightsOk) {
    for (const metric of (insightsBody as InsightsResponse).data ?? []) {
      const value = metric.values?.[0]?.value;
      if (typeof value === 'number') byName.set(metric.name, value);
    }
  }

  return {
    likeCount: fields.like_count ?? null,
    commentsCount: fields.comments_count ?? null,
    reach: byName.get('reach') ?? null,
    saved: byName.get('saved') ?? null,
    raw: {
      fields: fieldsBody,
      insights: insightsOk ? insightsBody : { error: graphErrorMessage(insightsBody, 'unknown') },
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
        isNotNull(schema.scheduledPosts.igMediaId),
        gte(schema.scheduledPosts.updatedAt, cutoff),
      ),
    );

  // igMediaId is proven non-null by the isNotNull filter above; narrowed here
  // because the query builder's inferred type can't express that from a
  // runtime WHERE clause.
  return rows
    .filter((row): row is EligiblePost & { igMediaId: string } => row.igMediaId !== null)
    .map((row) => ({ ...row, igMediaId: row.igMediaId as string }));
}

async function syncOnePost(
  ctx: WorkerContext,
  encryption: TokenEncryption | null,
  post: EligiblePost,
): Promise<void> {
  const { account } = post;

  if (account.tokenExpiresAt.getTime() <= Date.now()) {
    // Same signal SocialService.postToInstagram writes on the same condition —
    // a token expiring is discovered by whichever job touches the account
    // first, publish or sync, and both should leave it in the same state.
    await ctx.db
      .update(schema.socialAccounts)
      .set({ status: 'token_expired' as const })
      .where(eq(schema.socialAccounts.id, account.id));
    await ctx.db.insert(schema.postInsights).values({
      scheduledPostId: post.scheduledPostId,
      brandId: post.brandId,
      error: `Instagram token for ${account.displayName} has expired.`,
    });
    return;
  }

  let accessToken: string;
  try {
    accessToken = encryption ? encryption.decrypt(account.pageAccessToken) : account.pageAccessToken;
  } catch (error) {
    await ctx.db.insert(schema.postInsights).values({
      scheduledPostId: post.scheduledPostId,
      brandId: post.brandId,
      error: `Stored token could not be decrypted: ${describeError(error)}`,
    });
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
    await ctx.db.insert(schema.postInsights).values({
      scheduledPostId: post.scheduledPostId,
      brandId: post.brandId,
      error: describeError(error),
    });
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
