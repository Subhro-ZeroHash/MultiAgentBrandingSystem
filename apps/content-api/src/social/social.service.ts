import { randomUUID } from 'node:crypto';
import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and, schema, type Database } from '@bmas/db';
import { type SocialAccount } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';
import { TokenEncryption } from './crypto.js';
import { loadEnv } from '../config/env.js';
import { buildAssetLink } from '../assets/asset-proxy.js';

/**
 * Meta returns two different error shapes across the hosts this file talks to:
 * graph.instagram.com nests it under `error`, while api.instagram.com's OAuth
 * endpoint returns `error_message` at the top level. Reading only the first
 * shape reduced "Invalid platform app" — the message that says the app id is
 * wrong — to a bare "HTTP 400".
 */
interface ErrorResponse {
  error?: { message?: string; type?: string; code?: number };
  error_message?: string;
  error_type?: string;
  error_description?: string;
}

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

/** Publishing needs the second one; the first is only enough to read the
 *  profile. Both are granted on the same consent screen. */
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'].join(',');

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls the actionable detail out of whichever error shape came back; the bare
 *  status ("Bad Request") tells the user nothing about what to fix. */
function graphErrorMessage(body: unknown, fallback: string): string {
  const error = body as ErrorResponse | null;
  return (
    error?.error?.message ?? error?.error_message ?? error?.error_description ?? fallback
  );
}

/** True when the payload reports a failure, whatever the HTTP status says. */
function isErrorPayload(body: unknown): boolean {
  const error = body as ErrorResponse | null;
  return Boolean(error?.error ?? error?.error_message ?? error?.error_type);
}

@Injectable()
export class SocialService {
  private encryption: TokenEncryption | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database) {
    const env = loadEnv();
    if (env.ENCRYPTION_KEY) {
      this.encryption = new TokenEncryption(env.ENCRYPTION_KEY);
    }
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
    // GET against graph.instagram.com.
    const tokenResponse = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: cleanCode,
      }).toString(),
    });

    const tokenBody: unknown = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok || isErrorPayload(tokenBody)) {
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
    if (profile.account_type && !PUBLISHABLE_ACCOUNT_TYPES.has(profile.account_type.toUpperCase())) {
      throw new BadRequestException(
        `"${profile.username ?? 'That account'}" is a ${profile.account_type.toLowerCase()} account. ` +
          'Instagram only allows posting through the API from a Business or Creator account — ' +
          'switch it in Instagram under Settings > Account type, then connect again.',
      );
    }

    const encryptedToken =
      this.encryption?.encrypt(longLived.access_token) ?? longLived.access_token;
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

    if (!response.ok || isErrorPayload(body)) {
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

    if (!response.ok || isErrorPayload(body)) {
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
        and(
          eq(schema.socialAccounts.id, accountId),
          eq(schema.socialAccounts.ownerId, userId),
        ),
      )
      .limit(1);

    if (!accounts[0]) throw new NotFoundException('Social account not found');
    return accounts[0];
  }

  async disconnectAccount(accountId: string, userId: string): Promise<void> {
    const account = await this.getAccount(accountId, userId);
    await this.db
      .delete(schema.socialAccounts)
      .where(eq(schema.socialAccounts.id, account.id));
  }

  getDecryptedToken(account: SocialAccount): string {
    if (!this.encryption) return account.pageAccessToken;
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
    if (account.tokenExpiresAt.getTime() <= Date.now()) {
      await this.db
        .update(schema.socialAccounts)
        .set({ status: 'token_expired' as const })
        .where(eq(schema.socialAccounts.id, account.id));
      throw new BadRequestException(
        `The Instagram connection for ${account.displayName} has expired. Reconnect the account and try again.`,
      );
    }

    // Only reachable on the raw-imageUrl path; a link built from an asset id is
    // public by construction.
    if (!/^https?:\/\//i.test(imageUrl) || /localhost|127\.0\.0\.1|192\.168\.|10\.\d/i.test(imageUrl)) {
      throw new BadRequestException(
        'Instagram downloads the image from this URL, so it must be publicly reachable. A localhost or LAN address will not work.',
      );
    }

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
