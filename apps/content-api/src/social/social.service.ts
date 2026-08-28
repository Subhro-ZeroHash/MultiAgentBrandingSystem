import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq, and, desc, gte, isNull, schema, type Database } from '@bmas/db';
import { type SocialAccount } from '@bmas/db';
import {
  graphErrorMessage,
  isGraphErrorPayload,
  isTokenExpired,
  TokenEncryption,
  type InstagramAccountInsights,
  type InstagramMediaItem,
  type InstagramPerformanceSummary,
} from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';
import { loadEnv } from '../config/env.js';
import { buildAssetLink } from '../assets/asset-proxy.js';
import { assertPublicHost, BlockedAddressError } from '../brand-site/net-guard.js';

/**
 * Instagram API with Instagram Login. The account signs in with Instagram and
 * publishes through graph.instagram.com; no Facebook Page is involved at any
 * point. Deliberately not the Facebook-Login variant, which reaches the same
 * publishing endpoints via a Page and makes users authenticate with Facebook.
 *
 * The account must still be a Business or Creator account — personal Instagram
 * accounts cannot publish through any Meta API.
 */
const GRAPH_BASE = 'https://graph.instagram.com/v21.0';
const OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token';

/**
 * Publishing needs the second one; the first is only enough to read the
 * profile, its media, and the comments on that media. All are granted on the
 * same consent screen.
 *
 * `manage_insights` is what unlocks reach, impressions, saves and total
 * interactions — verified against the live API, those return 403 "Application
 * does not have permission" without it, while like/comment counts and comment
 * text come back fine on `basic` alone. An account connected before this was
 * added keeps working for everything except those metrics; it has to
 * reconnect once to pick up the wider grant, which is why the insights sync
 * treats a 403 here as "not granted yet" rather than a hard failure.
 */
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
].join(',');

/** Only professional accounts can publish through the API. A personal account
 *  authenticates fine and then fails at the first /media call, so it is
 *  rejected at connect time where the message can still be acted on. */
const PUBLISHABLE_ACCOUNT_TYPES = new Set(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']);

/** How long an issued OAuth state stays redeemable. Long enough to log in and
 *  pass a checkpoint, short enough that a leaked link goes stale. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Meta fetches and transcodes the image before it can be published; publishing
 *  a container that is still IN_PROGRESS fails with an unhelpful error. */
const CONTAINER_POLL_ATTEMPTS = 10;
const CONTAINER_POLL_INTERVAL_MS = 2000;

/** Video's own ceiling, separate from the image one above: transcoding a clip
 *  routinely takes past the 20 seconds an image container needs, so reusing
 *  the same numbers would abandon a Reel that was still genuinely processing.
 *  120 seconds total is generous for the short (<=20s) clips this pipeline
 *  produces without leaving a failed request hanging indefinitely. */
const REEL_CONTAINER_POLL_ATTEMPTS = 40;
const REEL_CONTAINER_POLL_INTERVAL_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The metric columns a performance roll-up reads; narrower than the full row
 *  so the pure helpers below can be exercised without building one. */
interface MetricSample {
  igMediaId: string;
  fetchedAt: Date;
  likeCount: number | null;
  commentsCount: number | null;
  reach: number | null;
  saved: number | null;
}

/**
 * Newest sample per media, from rows already sorted newest-first.
 *
 * `post_insights` keeps every sync as its own row so a post's engagement
 * curve is visible; summing them all would count one post's likes once per
 * sweep, inflating every total by however often the sync happened to run.
 */
export function latestPerMedia<T extends MetricSample>(rowsNewestFirst: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rowsNewestFirst) {
    if (seen.has(row.igMediaId)) continue;
    seen.add(row.igMediaId);
    out.push(row);
  }
  return out;
}

/** Sums the window's metrics. Likes and comments are always present, so they
 *  total to a number; reach and saved stay null when no measured post carried
 *  them — a missing grant is not the same as zero reach. */
export function sumMetrics(samples: MetricSample[]): {
  likes: number;
  comments: number;
  reach: number | null;
  saved: number | null;
} {
  let likes = 0;
  let comments = 0;
  let reach: number | null = null;
  let saved: number | null = null;

  for (const sample of samples) {
    likes += sample.likeCount ?? 0;
    comments += sample.commentsCount ?? 0;
    if (sample.reach !== null) reach = (reach ?? 0) + sample.reach;
    if (sample.saved !== null) saved = (saved ?? 0) + sample.saved;
  }
  return { likes, comments, reach, saved };
}

/** Interactions as a percentage of reach. Null without reach, and null on
 *  zero reach rather than dividing by it. */
export function engagementRate(totals: {
  likes: number;
  comments: number;
  reach: number | null;
}): number | null {
  if (totals.reach === null || totals.reach === 0) return null;
  return ((totals.likes + totals.comments) / totals.reach) * 100;
}

/**
 * Percentage change from `before` to `after`.
 *
 * Null when there is nothing to compare against — no previous observation, or
 * a previous value of zero. Reporting "+100%" off a zero baseline reads as
 * real growth when it only means the metric existed this time and not last.
 */
export function percentChange(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
}

@Injectable()
export class SocialService {
  private readonly encryption: TokenEncryption;

  constructor(@Inject(DATABASE) private readonly db: Database) {
    this.encryption = new TokenEncryption(loadEnv().ENCRYPTION_KEY);
  }

  /** Everything the OAuth hops need, validated once so a missing value fails
   *  with a clear message instead of a Graph error about a blank client_id. */
  private oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
    const env = loadEnv();
    if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
      throw new BadRequestException(
        'Instagram is not configured on the server: set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.',
      );
    }
    if (!env.INSTAGRAM_OAUTH_REDIRECT_URI) {
      throw new BadRequestException(
        'Instagram is not configured on the server: set INSTAGRAM_OAUTH_REDIRECT_URI.',
      );
    }
    return {
      clientId: env.INSTAGRAM_APP_ID,
      clientSecret: env.INSTAGRAM_APP_SECRET,
      redirectUri: env.INSTAGRAM_OAUTH_REDIRECT_URI,
    };
  }

  /**
   * Issues the consent-screen URL plus the `state` that must come back with it.
   *
   * State is minted here rather than accepted from the caller: it is what ties
   * the returning browser to the request that started it, so a value the caller
   * chose proves nothing. It also carries the user id across the redirect,
   * which the callback otherwise has no way to learn — the browser arrives from
   * Instagram with no session of ours attached.
   *
   * In-process storage, so a restart invalidates pending logins and a second
   * replica would not recognise them. Both are acceptable while this is
   * single-instance; a shared store is the fix when it is not.
   */
  private readonly pendingStates = new Map<string, { userId: string; expiresAt: number }>();

  getOAuthUrl(userId: string): { url: string; state: string } {
    const { clientId, redirectUri } = this.oauthConfig();

    this.prunePendingStates();
    const state = randomUUID();
    this.pendingStates.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: 'code',
      state,
      // Without this, an account with an existing grant gets Instagram's
      // lightweight "continue sharing?" reconfirmation instead of a full
      // consent pass — and the code that shortcut issues has been failing
      // token exchange with a redirect_uri error even though every value on
      // our side matches exactly. Forcing a real consent pass avoids it.
      force_reauth: 'true',
    });

    return { url: `${OAUTH_AUTHORIZE}?${params.toString()}`, state };
  }

  /** Redeems a state exactly once and returns whose login it belongs to. */
  private consumeState(state: string): string {
    this.prunePendingStates();
    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new BadRequestException(
        'This Instagram sign-in link has expired or was already used. Start the connection again.',
      );
    }
    this.pendingStates.delete(state);
    return pending.userId;
  }

  private prunePendingStates(): void {
    const now = Date.now();
    for (const [key, value] of this.pendingStates) {
      if (value.expiresAt <= now) this.pendingStates.delete(key);
    }
  }

  async exchangeCodeForToken(code: string, state: string): Promise<SocialAccount> {
    const { clientId, clientSecret, redirectUri } = this.oauthConfig();
    const userId = this.consumeState(state);

    // Instagram appends '#_' to the code when it redirects a browser. It is not
    // part of the code and the exchange rejects it.
    const cleanCode = code.replace(/#_$/, '');

    // This one hop is form-POSTed to api.instagram.com; every later call is a
    // GET against graph.instagram.com. Instagram's docs use curl -F for this
    // endpoint (multipart), not -d (urlencoded) — sending urlencoded here
    // makes Instagram fail to parse redirect_uri server-side and report it as
    // "not identical" even when the value it received is byte-for-byte
    // correct, so this must stay multipart/form-data (no Content-Type header:
    // fetch sets the multipart boundary itself from the FormData body).
    const tokenForm = new FormData();
    tokenForm.set('client_id', clientId);
    tokenForm.set('client_secret', clientSecret);
    tokenForm.set('grant_type', 'authorization_code');
    tokenForm.set('redirect_uri', redirectUri);
    tokenForm.set('code', cleanCode);
    const tokenResponse = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      body: tokenForm,
    });

    const tokenBody: unknown = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok || isGraphErrorPayload(tokenBody)) {
      // The code itself is never logged, redacted or not — it's a live,
      // redeemable credential for as long as it's unexpired/unused, and a
      // log line outliving that window is the common case, not the
      // exception. Lengths are enough to tell "empty"/"got mangled in
      // transit" apart from a genuine provider-side rejection.
      console.error(
        '[instagram-oauth-debug]',
        JSON.stringify({
          rawCodeLength: code.length,
          cleanCodeLength: cleanCode.length,
          redirectUri,
          status: tokenResponse.status,
          body: tokenBody,
        }),
      );
      throw new BadRequestException(
        `Instagram: could not exchange the authorization code — ${graphErrorMessage(
          tokenBody,
          `HTTP ${tokenResponse.status}`,
        )}`,
      );
    }

    const shortLived = tokenBody as { access_token?: string; user_id?: number | string };
    if (!shortLived.access_token) {
      throw new BadRequestException('Instagram returned no access token for that code.');
    }

    // Short-lived tokens last an hour; this trades one in for 60 days. It can
    // be refreshed indefinitely while the account stays active.
    const longLived = await this.graphGet<{ access_token: string; expires_in?: number }>(
      'access_token',
      {
        grant_type: 'ig_exchange_token',
        client_secret: clientSecret,
        access_token: shortLived.access_token,
      },
      'exchange for a long-lived token',
    );

    const profile = await this.graphGet<{
      user_id?: string;
      id?: string;
      username?: string;
      account_type?: string;
    }>(
      'me',
      { fields: 'user_id,username,account_type', access_token: longLived.access_token },
      'read your Instagram profile',
    );

    // The publishing endpoints are addressed by the Instagram user id.
    const igUserId = profile.user_id ?? profile.id;
    if (!igUserId) {
      throw new BadRequestException('Instagram did not return an account id for this login.');
    }

    // Caught here rather than at the first failed post: by then the account is
    // stored, looks connected, and the failure reads as a bug in the app.
    if (
      profile.account_type &&
      !PUBLISHABLE_ACCOUNT_TYPES.has(profile.account_type.toUpperCase())
    ) {
      throw new BadRequestException(
        `"${profile.username ?? 'That account'}" is a ${profile.account_type.toLowerCase()} account. ` +
          'Instagram only allows posting through the API from a Business or Creator account — ' +
          'switch it in Instagram under Settings > Account type, then connect again.',
      );
    }

    const encryptedToken = this.encryption.encrypt(longLived.access_token);
    // Trust the reported lifetime when present rather than assuming 60 days;
    // the refresh job keys off this column.
    const expiresAt = new Date(Date.now() + (longLived.expires_in ?? 60 * 24 * 60 * 60) * 1000);
    const displayName = profile.username ? `@${profile.username}` : 'Instagram account';

    // Reconnecting is how a user recovers from an expired or revoked token, so
    // it has to replace the stored credential in place. Inserting blind would
    // trip the unique index and surface as a 500.
    const accounts = await this.db
      .insert(schema.socialAccounts)
      .values({
        ownerId: userId,
        platform: 'instagram' as const,
        // No Facebook Page exists in this flow.
        pageId: null,
        igBusinessId: igUserId,
        pageAccessToken: encryptedToken,
        tokenExpiresAt: expiresAt,
        displayName,
        status: 'active' as const,
      })
      .onConflictDoUpdate({
        target: [
          schema.socialAccounts.ownerId,
          schema.socialAccounts.platform,
          schema.socialAccounts.igBusinessId,
        ],
        set: {
          pageAccessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          displayName,
          status: 'active' as const,
          connectedAt: new Date(),
        },
      })
      .returning();

    if (!accounts[0]) {
      throw new Error('Failed to create social account record');
    }

    return accounts[0];
  }

  /** GET against the Graph API. Graph signals failure both by HTTP status and
   *  by an `error` object in a 200 body, so both are checked here rather than
   *  at each call site. */
  private async graphGet<T>(
    path: string,
    params: Record<string, string>,
    action: string,
  ): Promise<T> {
    const response = await fetch(`${GRAPH_BASE}/${path}?${new URLSearchParams(params).toString()}`);
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok || isGraphErrorPayload(body)) {
      throw new BadRequestException(
        `Instagram: could not ${action} — ${graphErrorMessage(body, `HTTP ${response.status}`)}`,
      );
    }
    return body as T;
  }

  /** POST against the Graph API, form-encoded as Graph expects. */
  private async graphPost<T>(
    path: string,
    params: Record<string, string>,
    action: string,
  ): Promise<T> {
    const response = await fetch(`${GRAPH_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok || isGraphErrorPayload(body)) {
      throw new BadRequestException(
        `Instagram: could not ${action} — ${graphErrorMessage(body, `HTTP ${response.status}`)}`,
      );
    }
    return body as T;
  }

  async getUserAccounts(userId: string): Promise<SocialAccount[]> {
    return this.db
      .select()
      .from(schema.socialAccounts)
      .where(eq(schema.socialAccounts.ownerId, userId));
  }

  async getAccount(accountId: string, userId: string): Promise<SocialAccount> {
    const accounts = await this.db
      .select()
      .from(schema.socialAccounts)
      .where(
        and(eq(schema.socialAccounts.id, accountId), eq(schema.socialAccounts.ownerId, userId)),
      )
      .limit(1);

    if (!accounts[0]) throw new NotFoundException('Social account not found');
    return accounts[0];
  }

  /**
   * Account stats plus recent posts, read live from Instagram.
   *
   * Deliberately not served from `content.post_insights`: that table only
   * covers posts *this app* published (it keys off the `ig_media_id` our own
   * publish flow records), so for an account that posts from the Instagram
   * app it is permanently empty. `me/media` returns the real timeline
   * including `like_count`/`comments_count`, and needs only the
   * `instagram_business_basic` scope the connection already has — no
   * `manage_insights` grant and no reconnect.
   *
   * Live rather than cached because there is no sync job behind this yet;
   * a stale-cache layer is the fix when the call cost matters, not before.
   */
  async getAccountInsights(
    accountId: string,
    userId: string,
    mediaLimit = 12,
  ): Promise<InstagramAccountInsights> {
    const account = await this.getAccount(accountId, userId);
    const token = await this.tokenForReading(account);

    // `profile_picture_url` is requested but not guaranteed — it comes back
    // only for some account types, so it stays optional rather than being
    // treated as a failure when absent.
    const profile = await this.graphGet<{
      user_id?: string;
      id?: string;
      username?: string;
      name?: string;
      account_type?: string;
      profile_picture_url?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
    }>(
      'me',
      {
        fields:
          'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count',
        access_token: token,
      },
      'read your Instagram profile',
    );

    const media = await this.graphGet<{ data?: InstagramMediaItem[] }>(
      'me/media',
      {
        fields:
          'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
        limit: String(mediaLimit),
        access_token: token,
      },
      'read your recent Instagram posts',
    );

    return {
      accountId: account.id,
      username: profile.username ?? null,
      name: profile.name ?? null,
      accountType: profile.account_type ?? null,
      profilePictureUrl: profile.profile_picture_url ?? null,
      followersCount: profile.followers_count ?? 0,
      followsCount: profile.follows_count ?? 0,
      mediaCount: profile.media_count ?? 0,
      media: (media.data ?? []).map((item) => ({
        id: item.id,
        caption: item.caption ?? null,
        mediaType: item.media_type ?? null,
        // A video's `media_url` is the file itself; `thumbnail_url` is the
        // only thing an <Image> can render for it.
        mediaUrl: item.thumbnail_url ?? item.media_url ?? null,
        permalink: item.permalink ?? null,
        timestamp: item.timestamp ?? null,
        likeCount: item.like_count ?? 0,
        commentsCount: item.comments_count ?? 0,
      })),
    };
  }

  /**
   * Aggregated performance over a trailing window, from the sync's stored
   * history rather than a live call.
   *
   * `post_insights` is append-only — one row per media per sync — so totals
   * take the newest sample per media rather than summing every sample, which
   * would multiply a post's numbers by how many times it happened to be
   * swept. Deltas compare against the preceding window of the same length,
   * and are null when there is no earlier data to compare against rather than
   * being reported as a 100% rise from zero.
   */
  async getAccountPerformance(
    accountId: string,
    userId: string,
    windowDays = 30,
  ): Promise<InstagramPerformanceSummary> {
    const account = await this.getAccount(accountId, userId);
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const windowStart = new Date(now - windowMs);
    const previousStart = new Date(now - windowMs * 2);

    const rows = await this.db
      .select()
      .from(schema.postInsights)
      .where(
        and(
          eq(schema.postInsights.socialAccountId, account.id),
          gte(schema.postInsights.fetchedAt, previousStart),
          isNull(schema.postInsights.error),
        ),
      )
      .orderBy(desc(schema.postInsights.fetchedAt));

    const current = latestPerMedia(rows.filter((row) => row.fetchedAt >= windowStart));
    const previous = latestPerMedia(rows.filter((row) => row.fetchedAt < windowStart));

    const currentTotals = sumMetrics(current);
    const previousTotals = sumMetrics(previous);

    const comments = await this.db
      .select({
        id: schema.postComments.id,
        igMediaId: schema.postComments.igMediaId,
        text: schema.postComments.text,
        username: schema.postComments.username,
        likeCount: schema.postComments.likeCount,
        commentedAt: schema.postComments.commentedAt,
      })
      .from(schema.postComments)
      .where(eq(schema.postComments.socialAccountId, account.id))
      .orderBy(desc(schema.postComments.commentedAt))
      .limit(25);

    return {
      accountId: account.id,
      windowDays,
      postsMeasured: current.length,
      lastSyncedAt: rows[0]?.fetchedAt.toISOString() ?? null,
      // Reach comes back only with the manage_insights grant, so its presence
      // on any measured post is what tells us the grant is live.
      insightsGranted: current.some((row) => row.reach !== null),
      totals: currentTotals,
      engagementRate: engagementRate(currentTotals),
      deltas: {
        likes: percentChange(previousTotals.likes, currentTotals.likes),
        comments: percentChange(previousTotals.comments, currentTotals.comments),
        reach: percentChange(previousTotals.reach, currentTotals.reach),
        engagementRate: percentChange(
          engagementRate(previousTotals),
          engagementRate(currentTotals),
        ),
      },
      recentComments: comments.map((comment) => ({
        id: comment.id,
        igMediaId: comment.igMediaId,
        text: comment.text,
        username: comment.username,
        likeCount: comment.likeCount,
        commentedAt: comment.commentedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Decrypts an account's token for a read-only call, failing the same way
   * `postToInstagram` does when it has expired — including flipping the
   * stored status, so the UI can show the connection as needing attention
   * rather than silently rendering an error every refresh.
   */
  private async tokenForReading(account: SocialAccount): Promise<string> {
    if (isTokenExpired(account.tokenExpiresAt)) {
      await this.db
        .update(schema.socialAccounts)
        .set({ status: 'token_expired' as const })
        .where(eq(schema.socialAccounts.id, account.id));
      throw new BadRequestException(
        `The Instagram connection for ${account.displayName} has expired. Reconnect the account and try again.`,
      );
    }
    return this.getDecryptedToken(account);
  }

  async disconnectAccount(accountId: string, userId: string): Promise<void> {
    const account = await this.getAccount(accountId, userId);
    await this.db.delete(schema.socialAccounts).where(eq(schema.socialAccounts.id, account.id));
  }

  getDecryptedToken(account: SocialAccount): string {
    try {
      return this.encryption.decrypt(account.pageAccessToken);
    } catch (e) {
      // Previously this fell through to returning the ciphertext, which was
      // then sent to Instagram as if it were a token. The resulting "invalid
      // OAuth token" pointed at the account instead of at the real cause: the
      // stored value cannot be read with the current ENCRYPTION_KEY.
      console.error(`[social] token decryption failed for account ${account.id}:`, e);
      throw new BadRequestException(
        'The stored Instagram token could not be decrypted — ENCRYPTION_KEY has changed since it was saved. Disconnect the account and connect it again.',
      );
    }
  }

  /**
   * Guards a caller-supplied `imageUrl`/`videoUrl` before handing it to Meta.
   *
   * Only reachable on the raw-URL path — a link built from an asset id is
   * public by construction (see buildAssetLink). Reuses net-guard.ts's
   * `assertPublicHost` (built for the brand-site import feature) rather than
   * a second, weaker hand-rolled check: the previous version here was a plain
   * regex with no DNS resolution, so a hostname that merely *resolves* to a
   * private address — or the cloud metadata address, which the regex never
   * blocked at all — sailed straight through.
   */
  private async assertPubliclyReachableUrl(url: string, mediaKind: 'image' | 'video'): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException(`${mediaKind}Url is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`${mediaKind}Url must be http or https.`);
    }
    try {
      await assertPublicHost(parsed.hostname);
    } catch (error) {
      if (error instanceof BlockedAddressError) {
        throw new BadRequestException(
          `Instagram downloads the ${mediaKind} from this URL, so it must be publicly reachable. A localhost or LAN address will not work.`,
        );
      }
      throw error;
    }
  }

  /**
   * Turns an asset id into a URL Meta's servers can actually download.
   *
   * Presigned storage URLs are signed for S3_PUBLIC_ENDPOINT, which is a LAN
   * address — fine for the user's phone, unreachable for Instagram. So the
   * image is served through the public tunnel instead, behind a signature.
   */
  private async publicImageUrlForAsset(assetId: string, userId: string): Promise<string> {
    const env = loadEnv();
    if (!env.PUBLIC_ASSET_BASE_URL) {
      throw new BadRequestException(
        'Publishing needs PUBLIC_ASSET_BASE_URL set to a public https origin (your tunnel), because Instagram downloads the image from its own servers.',
      );
    }
    if (!env.ENCRYPTION_KEY) {
      throw new BadRequestException('Publishing needs ENCRYPTION_KEY set to sign the image link.');
    }

    // Joined through to the owning brand rather than looked up by asset id
    // alone — otherwise any caller with an Instagram account connected could
    // publish someone else's generated asset by guessing/passing its id.
    const rows = await this.db
      .select({ id: schema.creativeAssets.id, ownerId: schema.brands.ownerId })
      .from(schema.creativeAssets)
      .innerJoin(schema.generationJobs, eq(schema.creativeAssets.jobId, schema.generationJobs.id))
      .innerJoin(schema.brands, eq(schema.generationJobs.brandId, schema.brands.id))
      .where(eq(schema.creativeAssets.id, assetId))
      .limit(1);

    if (!rows[0]) throw new NotFoundException('Asset not found');
    if (rows[0].ownerId !== userId) {
      throw new ForbiddenException('This asset belongs to another account.');
    }

    // The `ig` rendition, not the stored bytes: a print format like poster_a4 is
    // 2480x3508 (0.707), below Instagram's 4:5 floor, and Meta rejects it
    // outright. The proxy letterboxes it into a legal shape on the way out.
    const link = buildAssetLink(env.PUBLIC_ASSET_BASE_URL, assetId, env.ENCRYPTION_KEY, {
      variant: 'ig',
    }).url;

    await this.assertImageUrlReachable(link, env.PUBLIC_ASSET_BASE_URL);
    return link;
  }

  /**
   * Video's counterpart to `publicImageUrlForAsset` — same tunnel-URL
   * necessity, same ownership join, joined through `videoGenerationJobs`
   * instead of `generationJobs`. Requested as `raw`: there is no Reels
   * equivalent of the `ig` letterbox rendition, since the request already
   * asked LTX to render at a Reels-legal size rather than whatever shape a
   * stored image happened to be.
   */
  private async publicVideoUrlForAsset(assetId: string, userId: string): Promise<string> {
    const env = loadEnv();
    if (!env.PUBLIC_ASSET_BASE_URL) {
      throw new BadRequestException(
        'Publishing needs PUBLIC_ASSET_BASE_URL set to a public https origin (your tunnel), because Instagram downloads the video from its own servers.',
      );
    }
    if (!env.ENCRYPTION_KEY) {
      throw new BadRequestException('Publishing needs ENCRYPTION_KEY set to sign the video link.');
    }

    const rows = await this.db
      .select({ id: schema.videoAssets.id, ownerId: schema.brands.ownerId })
      .from(schema.videoAssets)
      .innerJoin(
        schema.videoGenerationJobs,
        eq(schema.videoAssets.jobId, schema.videoGenerationJobs.id),
      )
      .innerJoin(schema.brands, eq(schema.videoGenerationJobs.brandId, schema.brands.id))
      .where(eq(schema.videoAssets.id, assetId))
      .limit(1);

    if (!rows[0]) throw new NotFoundException('Video asset not found');
    if (rows[0].ownerId !== userId) {
      throw new ForbiddenException('This asset belongs to another account.');
    }

    const link = buildAssetLink(env.PUBLIC_ASSET_BASE_URL, assetId, env.ENCRYPTION_KEY, {
      variant: 'raw',
      // A video is a multi-hundred-KB-to-multi-MB download and Meta's own
      // Reels container processing routinely runs past a minute (see
      // REEL_CONTAINER_POLL_ATTEMPTS below) — the default 15-minute TTL an
      // image link uses would be needlessly short here if it were shorter,
      // so the same constant is reused rather than picking a new number.
    }).url;

    await this.assertVideoUrlReachable(link, env.PUBLIC_ASSET_BASE_URL);
    return link;
  }

  /** Video counterpart of `assertImageUrlReachable` — same stale-tunnel
   *  diagnosis, checked against `video/` instead of `image/`. */
  private async assertVideoUrlReachable(url: string, baseUrl: string): Promise<void> {
    const staleTunnelHint =
      `Instagram could not have downloaded the video: ${baseUrl} is not serving it. ` +
      'That origin is almost certainly a stale tunnel — the free Cloudflare URL changes ' +
      'every time `pnpm tunnel` restarts. Restart the tunnel and set both ' +
      'PUBLIC_ASSET_BASE_URL and INSTAGRAM_OAUTH_REDIRECT_URI to the new hostname.';

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new BadRequestException(staleTunnelHint);
    }

    void response.body?.cancel();

    if (!response.ok) {
      throw new BadRequestException(
        `${staleTunnelHint} (it answered ${response.status} for the signed video link)`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('video/')) {
      throw new BadRequestException(
        `${baseUrl} answered with '${contentType || 'no content-type'}' instead of a video for ` +
          'the signed link. If that origin is a tunnel, it is pointing somewhere other than the web app.',
      );
    }
  }

  /**
   * Confirms the image URL actually serves an image before Meta is asked to
   * download it.
   *
   * Without this, a `PUBLIC_ASSET_BASE_URL` pointing at a dead tunnel — the
   * normal state of affairs a few hours after `pnpm tunnel` was last run,
   * since the free Cloudflare URL changes on every restart — surfaces as
   * Meta's "Only photo or video can be accepted as media type". That message
   * describes what Meta received (an error page) rather than why, and sends
   * you looking at the image, the aspect ratio, or the account, none of which
   * are the problem. Failing here instead names the actual cause.
   */
  private async assertImageUrlReachable(url: string, baseUrl: string): Promise<void> {
    const staleTunnelHint =
      `Instagram could not have downloaded the image: ${baseUrl} is not serving it. ` +
      'That origin is almost certainly a stale tunnel — the free Cloudflare URL changes ' +
      'every time `pnpm tunnel` restarts. Restart the tunnel and set both ' +
      'PUBLIC_ASSET_BASE_URL and INSTAGRAM_OAUTH_REDIRECT_URI to the new hostname.';

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new BadRequestException(staleTunnelHint);
    }

    // The body is never needed here — only the headers prove the URL serves an
    // image. Cancelling avoids pulling the whole file across the tunnel twice
    // (once for this check, once for Meta).
    void response.body?.cancel();

    if (!response.ok) {
      throw new BadRequestException(
        `${staleTunnelHint} (it answered ${response.status} for the signed image link)`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      throw new BadRequestException(
        `${baseUrl} answered with '${contentType || 'no content-type'}' instead of an image for ` +
          'the signed link. Meta rejects that as "Only photo or video can be accepted as media ' +
          'type". If that origin is a tunnel, it is pointing somewhere other than the web app.',
      );
    }
  }

  /**
   * Recovers the asset behind a presigned storage URL.
   *
   * The path of such a URL is `/<bucket>/<storageKey>`, and the storage key is
   * what identifies the row. Returns undefined for anything that is not one of
   * ours, which leaves the caller's URL to be judged on its own merits.
   */
  private async resolveAssetIdFromUrl(imageUrl: string | undefined): Promise<string | undefined> {
    if (!imageUrl) return undefined;

    let path: string;
    try {
      // Query string dropped: the signature is irrelevant, only the key matters.
      path = decodeURIComponent(new URL(imageUrl).pathname).replace(/^\/+/, '');
    } catch {
      return undefined;
    }

    const bucket = loadEnv().S3_BUCKET;
    // Path-style URLs carry the bucket; virtual-hosted ones put it in the host.
    const candidates = [
      path.startsWith(`${bucket}/`) ? path.slice(bucket.length + 1) : undefined,
      path,
    ].filter((value): value is string => Boolean(value));

    for (const storageKey of candidates) {
      const rows = await this.db
        .select({ id: schema.creativeAssets.id })
        .from(schema.creativeAssets)
        .where(eq(schema.creativeAssets.storageKey, storageKey))
        .limit(1);
      if (rows[0]) return rows[0].id;
    }

    return undefined;
  }

  async postToInstagram(
    accountId: string,
    userId: string,
    source: { assetId?: string; imageUrl?: string },
    caption: string,
  ): Promise<{ postId: string; success: boolean }> {
    const account = await this.getAccount(accountId, userId);

    // An asset id is the normal path. A caller that sends a presigned storage
    // URL instead — an older client, or anything holding a URL from the gallery
    // — gets it translated rather than rejected, since that URL identifies an
    // asset we can serve publicly. Only a URL that resolves to nothing is left
    // to the reachability check below.
    const assetId = source.assetId ?? (await this.resolveAssetIdFromUrl(source.imageUrl));
    const imageUrl = assetId ? await this.publicImageUrlForAsset(assetId, userId) : source.imageUrl;

    if (!imageUrl) {
      throw new BadRequestException('assetId or imageUrl is required');
    }

    if (!account.igBusinessId) {
      throw new BadRequestException('This connection has no Instagram account id; reconnect it.');
    }

    // Checked before spending two round trips on a token Instagram will reject,
    // and recorded so the UI can show the account as needing attention.
    if (isTokenExpired(account.tokenExpiresAt)) {
      await this.db
        .update(schema.socialAccounts)
        .set({ status: 'token_expired' as const })
        .where(eq(schema.socialAccounts.id, account.id));
      throw new BadRequestException(
        `The Instagram connection for ${account.displayName} has expired. Reconnect the account and try again.`,
      );
    }

    await this.assertPubliclyReachableUrl(imageUrl, 'image');

    const token = this.getDecryptedToken(account);

    // Two steps by Graph's design: the container is created first so Meta can
    // fetch and transcode the image, then publishing is a separate call.
    const container = await this.graphPost<{ id: string }>(
      `${account.igBusinessId}/media`,
      { image_url: imageUrl, caption, access_token: token },
      'stage the image for publishing',
    );

    await this.awaitContainerReady(container.id, token);

    const published = await this.graphPost<{ id: string }>(
      `${account.igBusinessId}/media_publish`,
      { creation_id: container.id, access_token: token },
      'publish the post',
    );

    return { postId: published.id, success: true };
  }

  /**
   * Publishes a generated video as a Reel. Same two-step container/publish
   * shape `postToInstagram` uses for a photo — Graph API models every media
   * type the same way — with three differences: `media_type: 'REELS'` and
   * `video_url` instead of a bare image post, and its own, much longer
   * container-ready poll (`awaitReelContainerReady`) rather than the
   * image-tuned one, since Meta transcodes video server-side and that
   * routinely takes past the twenty seconds an image container needs.
   */
  async postReelToInstagram(
    accountId: string,
    userId: string,
    source: { assetId?: string; videoUrl?: string },
    caption: string,
  ): Promise<{ postId: string; success: boolean }> {
    const account = await this.getAccount(accountId, userId);

    const videoUrl = source.assetId
      ? await this.publicVideoUrlForAsset(source.assetId, userId)
      : source.videoUrl;

    if (!videoUrl) {
      throw new BadRequestException('assetId or videoUrl is required');
    }

    if (!account.igBusinessId) {
      throw new BadRequestException('This connection has no Instagram account id; reconnect it.');
    }

    if (isTokenExpired(account.tokenExpiresAt)) {
      await this.db
        .update(schema.socialAccounts)
        .set({ status: 'token_expired' as const })
        .where(eq(schema.socialAccounts.id, account.id));
      throw new BadRequestException(
        `The Instagram connection for ${account.displayName} has expired. Reconnect the account and try again.`,
      );
    }

    await this.assertPubliclyReachableUrl(videoUrl, 'video');

    const token = this.getDecryptedToken(account);

    const container = await this.graphPost<{ id: string }>(
      `${account.igBusinessId}/media`,
      { media_type: 'REELS', video_url: videoUrl, caption, access_token: token },
      'stage the video for publishing',
    );

    await this.awaitReelContainerReady(container.id, token);

    const published = await this.graphPost<{ id: string }>(
      `${account.igBusinessId}/media_publish`,
      { creation_id: container.id, access_token: token },
      'publish the reel',
    );

    return { postId: published.id, success: true };
  }

  /** Video's counterpart of `awaitContainerReady` — same polling shape, the
   *  longer ceiling `REEL_CONTAINER_POLL_ATTEMPTS`/`_INTERVAL_MS` exist for. */
  private async awaitReelContainerReady(containerId: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < REEL_CONTAINER_POLL_ATTEMPTS; attempt++) {
      const { status_code: status } = await this.graphGet<{ status_code?: string }>(
        containerId,
        { fields: 'status_code', access_token: token },
        'check whether the video finished processing',
      );

      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new BadRequestException(
          `Instagram could not process the video (${status.toLowerCase()}). Reels need an MP4 or MOV, ` +
            'under 1GB, between 3 and 90 seconds, with an aspect ratio between 0.01:1 and 10:1.',
        );
      }

      await sleep(REEL_CONTAINER_POLL_INTERVAL_MS);
    }

    throw new BadRequestException(
      `Instagram is still processing the video after ${(REEL_CONTAINER_POLL_ATTEMPTS * REEL_CONTAINER_POLL_INTERVAL_MS) / 1000} seconds. Try posting again in a moment.`,
    );
  }

  /**
   * Blocks until Meta has finished ingesting the container.
   *
   * Publishing straight after creating one usually works for a small image and
   * intermittently does not — the failure is a bare "Media ID is not available"
   * that looks like a bad id rather than a race.
   */
  private async awaitContainerReady(containerId: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < CONTAINER_POLL_ATTEMPTS; attempt++) {
      const { status_code: status } = await this.graphGet<{ status_code?: string }>(
        containerId,
        { fields: 'status_code', access_token: token },
        'check whether the image finished uploading',
      );

      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new BadRequestException(
          `Instagram could not process the image (${status.toLowerCase()}). It must be a JPEG under 8MB, reachable without authentication, with an aspect ratio between 4:5 and 1.91:1.`,
        );
      }

      await sleep(CONTAINER_POLL_INTERVAL_MS);
    }

    throw new BadRequestException(
      'Instagram is still processing the image after 20 seconds. Try posting again in a moment.',
    );
  }
}
