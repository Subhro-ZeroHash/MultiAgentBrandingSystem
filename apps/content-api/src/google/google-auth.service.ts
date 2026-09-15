import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@bmas/db';
import { TokenEncryption } from '@bmas/shared';
import { google } from 'googleapis';
import { DATABASE } from '../core/core.module.js';
import { loadEnv } from '../config/env.js';

/**
 * Google Business Profile OAuth — connect step only.
 *
 * Deliberately stops at "sign in, see who connected, store the token."
 * Reviews, posts and performance all read `business.manage`-scoped Business
 * Profile APIs that Google only unlocks after a manual approval of this GCP
 * project (see developers.google.com/my-business/content/prereqs); until that
 * lands, there is nothing for those features to call. `business.manage` is
 * still requested on the consent screen now, though — Google only returns
 * that grant on a fresh consent, so requesting it upfront means an already-
 * connected account works the moment approval comes through, with no need to
 * send the user through Connect Google a second time.
 */
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/business.manage',
];

const STATE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class GoogleAuthService {
  private readonly encryption: TokenEncryption;

  constructor(@Inject(DATABASE) private readonly db: Database) {
    this.encryption = new TokenEncryption(loadEnv().ENCRYPTION_KEY);
  }

  private oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
    const env = loadEnv();
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new BadRequestException(
        'Google is not configured on the server: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
      );
    }
    if (!env.GOOGLE_OAUTH_REDIRECT_URI) {
      throw new BadRequestException(
        'Google is not configured on the server: set GOOGLE_OAUTH_REDIRECT_URI.',
      );
    }
    return {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    };
  }

  private client() {
    const { clientId, clientSecret, redirectUri } = this.oauthConfig();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /** Same in-process, single-instance state store as Instagram's
   *  (`SocialService.pendingStates`) — a restart or a second replica
   *  invalidates pending logins, which is acceptable while deployment stays
   *  single-instance and matches the tradeoff already accepted there. */
  private readonly pendingStates = new Map<string, { userId: string; expiresAt: number }>();

  private prunePendingStates(): void {
    const now = Date.now();
    for (const [key, value] of this.pendingStates) {
      if (value.expiresAt <= now) this.pendingStates.delete(key);
    }
  }

  private consumeState(state: string): string {
    this.prunePendingStates();
    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new BadRequestException(
        'This Google sign-in link has expired or was already used. Start the connection again.',
      );
    }
    this.pendingStates.delete(state);
    return pending.userId;
  }

  getAuthUrl(userId: string): { url: string; state: string } {
    this.prunePendingStates();
    const state = randomUUID();
    this.pendingStates.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS });

    const url = this.client().generateAuthUrl({
      // Only way Google ever returns a refresh_token — without both of these,
      // the access token silently stops working in ~1 hour with no way to renew it.
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
    });

    return { url, state };
  }

  /** Redeems the code, stores the connection, and returns just enough to
   *  show the callback page and the app's account list something real —
   *  full parity with the stored row isn't needed by either caller. */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ email: string; displayName: string }> {
    const userId = this.consumeState(state);
    const client = this.client();

    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw new BadRequestException('Google returned no access token for that code.');
    }
    client.setCredentials(tokens);

    const { data: profile } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    if (!profile.id || !profile.email) {
      throw new BadRequestException('Google did not return an account id/email for this login.');
    }

    const encryptedAccessToken = this.encryption.encrypt(tokens.access_token);
    const expiresAt = new Date(tokens.expiry_date ?? Date.now() + 60 * 60 * 1000);

    // Build the row without `refreshToken` first, so a reconnect that gets no
    // refresh_token back (the common case — Google only issues one on the
    // very first consent) leaves the previously stored one untouched instead
    // of overwriting it with null.
    const values = {
      ownerId: userId,
      platform: 'google' as const,
      pageId: null,
      igBusinessId: profile.id,
      pageAccessToken: encryptedAccessToken,
      tokenExpiresAt: expiresAt,
      displayName: profile.email,
      status: 'active' as const,
      ...(tokens.refresh_token
        ? { refreshToken: this.encryption.encrypt(tokens.refresh_token) }
        : {}),
    };

    await this.db
      .insert(schema.socialAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.socialAccounts.ownerId,
          schema.socialAccounts.platform,
          schema.socialAccounts.igBusinessId,
        ],
        set: {
          pageAccessToken: encryptedAccessToken,
          tokenExpiresAt: expiresAt,
          displayName: profile.email,
          status: 'active' as const,
          connectedAt: new Date(),
          ...(tokens.refresh_token
            ? { refreshToken: this.encryption.encrypt(tokens.refresh_token) }
            : {}),
        },
      });

    return { email: profile.email, displayName: profile.email };
  }
}
