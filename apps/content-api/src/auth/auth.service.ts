import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, schema, type Database } from '@bmas/db';
import type { AuthResponse, AuthUser, LoginInput, SignupInput } from '@bmas/shared';
import * as bcrypt from 'bcrypt';
import nodemailer, { type Transporter } from 'nodemailer';
import { DATABASE } from '../core/core.module.js';
import { loadEnv } from '../config/env.js';

/** Brevo's SMTP relay — same host/port for every account, only the
 *  login/key differ. See BREVO_SMTP_LOGIN's doc comment in config/env.ts. */
const BREVO_SMTP_HOST = 'smtp-relay.brevo.com';
const BREVO_SMTP_PORT = 587;

/** Cost factor for bcrypt.hash. 12 is the current OWASP-recommended floor;
 *  raising it re-hashes nothing retroactively, so existing users stay on
 *  whatever cost they signed up under. */
const BCRYPT_ROUNDS = 12;

/** How long a refresh token is good for before it must be used or re-issued.
 *  Matches the access token's old 30-day lifetime, so this change doesn't
 *  make anyone log in more often — it only makes a stolen session revocable
 *  and bounds a stolen *access* token's blast radius to AUTH_TOKEN_TTL. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** How long a password-reset code is valid for. Short — it's a 6-digit code,
 *  not a signed link, so the real defence against guessing is this window
 *  plus the per-account rate limit on reset-password, not the code's size. */
const RESET_CODE_TTL_MS = 15 * 60_000;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Postgres `unique_violation`. The only constraint signup can trip is the
 *  unique index on `core.users.email`. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Walks the cause chain rather than reading `error.code` directly: Drizzle
 * wraps driver errors in a `DrizzleQueryError` whose own `code` is undefined,
 * and the `PostgresError` carrying the real one sits underneath as `cause`.
 * Checking only the top level silently misses every violation — which is how
 * the first version of this went out still returning 500s.
 */
function isUniqueViolation(error: unknown): boolean {
  // Bounded rather than `while (true)`: an error whose `cause` chain loops
  // would otherwise hang the request thread here.
  for (let current = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== 'object') break;
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** `undefined` means "not yet resolved", `null` means "resolved, no
   *  credentials configured" — created once and reused rather than a fresh
   *  SMTP connection per reset request. */
  private transporter: Transporter | null | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  private async issueTokenPair(
    user: AuthUser,
  ): Promise<Pick<AuthResponse, 'accessToken' | 'refreshToken'>> {
    const accessToken = this.jwt.sign({ sub: user.id });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.insert(schema.refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    // Runs on signup, login, and every silent refresh — one of the two
    // places (see AutopilotActivityService for the other, /auth/me) content-
    // worker's inactivity sweep needs stamped to tell "still using the app"
    // from "gone quiet for a week".
    await this.db
      .update(schema.users)
      .set({ lastActiveAt: new Date() })
      .where(eq(schema.users.id, user.id));
    return { accessToken, refreshToken };
  }

  async signup(input: SignupInput): Promise<AuthResponse> {
    const [existing] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, input.email))
      .limit(1);
    if (existing) throw new ConflictException('An account with this email already exists.');

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // The check above is an optimisation, not the guarantee — between it and
    // this insert another request can claim the same address, and bcrypt's
    // ~50ms hash widens that window considerably. The unique index on
    // `email` is what actually enforces it; catching its violation here is
    // what turns the loser of that race into the same 409 a sequential
    // duplicate gets, instead of an unhandled error surfacing as a 500.
    let row;
    try {
      [row] = await this.db
        .insert(schema.users)
        .values({
          email: input.email,
          name: input.name ?? null,
          passwordHash,
        })
        .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An account with this email already exists.');
      }
      throw error;
    }
    if (!row) throw new Error('Failed to create account');

    return { user: row, ...(await this.issueTokenPair(row)) };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const [row] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, input.email))
      .limit(1);

    // Same message whether the email doesn't exist or the password is wrong —
    // distinguishing them would let a caller enumerate registered emails.
    const invalid = () => new UnauthorizedException('Invalid email or password.');
    if (!row || !row.passwordHash) throw invalid();

    const matches = await bcrypt.compare(input.password, row.passwordHash);
    if (!matches) throw invalid();

    const user: AuthUser = { id: row.id, email: row.email, name: row.name };
    return { user, ...(await this.issueTokenPair(user)) };
  }

  /**
   * Rotates a refresh token: the presented token is revoked (single-use — a
   * captured copy that's already been redeemed by the real client fails
   * closed instead of being replayable) and a fresh access+refresh pair is
   * issued in its place.
   */
  async refresh(rawToken: string): Promise<Pick<AuthResponse, 'accessToken' | 'refreshToken'>> {
    const invalid = () => new UnauthorizedException('Invalid or expired refresh token.');

    // Atomic claim, not select-then-update: the `revokedAt IS NULL` check
    // re-runs at UPDATE time against whatever committed since, not against a
    // snapshot from an earlier SELECT. Two concurrent /auth/refresh calls
    // presenting the same raw token (a network-retry duplicate, two tabs)
    // both used to pass the old SELECT before either UPDATE landed, so both
    // proceeded to mint a session — one stolen-and-replayed token produced
    // two live sessions instead of the second failing closed, which is
    // exactly the property this table exists to give logout(). Only the
    // caller whose UPDATE actually revokes a row gets one back here.
    const [tokenRow] = await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, hashToken(rawToken)),
          isNull(schema.refreshTokens.revokedAt),
        ),
      )
      .returning({
        id: schema.refreshTokens.id,
        userId: schema.refreshTokens.userId,
        expiresAt: schema.refreshTokens.expiresAt,
      });
    if (!tokenRow || tokenRow.expiresAt < new Date()) throw invalid();

    const [user] = await this.db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, tokenRow.userId))
      .limit(1);
    if (!user) throw invalid();

    return this.issueTokenPair(user);
  }

  /** Idempotent: a missing or already-revoked token is not an error, same as
   *  login() giving the same message for a wrong password vs. an unknown
   *  email — the caller learns nothing from the difference. */
  async logout(rawToken: string): Promise<void> {
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, hashToken(rawToken)),
          isNull(schema.refreshTokens.revokedAt),
        ),
      );
  }

  /** Always resolves, whether or not the email is registered — same
   *  enumeration-safety shape as login()'s single "invalid" message. A send
   *  failure (SMTP outage, an unverified "from" address, bad credentials) is
   *  logged, not thrown: the caller learning "the send failed" is just as
   *  much a leak as learning "the email exists". */
  async forgotPassword(email: string): Promise<void> {
    const [user] = await this.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user) return;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.db
      .update(schema.users)
      .set({
        resetCodeHash: hashToken(code),
        resetCodeExpiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
      })
      .where(eq(schema.users.id, user.id));

    await this.sendResetCodeEmail(user.email, code).catch((error) => {
      this.logger.error(`Failed to send reset code to ${user.email}: ${String(error)}`);
    });
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const invalid = () => new UnauthorizedException('Invalid or expired reset code.');

    const [user] = await this.db
      .select({
        id: schema.users.id,
        resetCodeHash: schema.users.resetCodeHash,
        resetCodeExpiresAt: schema.users.resetCodeExpiresAt,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user?.resetCodeHash || !user.resetCodeExpiresAt) throw invalid();
    if (user.resetCodeExpiresAt < new Date()) throw invalid();
    if (user.resetCodeHash !== hashToken(code)) throw invalid();

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.db
      .update(schema.users)
      .set({ passwordHash, resetCodeHash: null, resetCodeExpiresAt: null })
      .where(eq(schema.users.id, user.id));

    // A reset means "treat every existing session as no longer trustworthy" —
    // same as a security-conscious "log out everywhere" after a password change.
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(schema.refreshTokens.userId, user.id), isNull(schema.refreshTokens.revokedAt)),
      );
  }

  /** SMTP, not REST — Brevo's API is a REST call like Resend's, but the
   *  instructions handed to this project are specifically for the SMTP
   *  relay, so nodemailer owns the protocol instead of a bare `fetch`.
   *
   *  Outside production, the code is always logged too — not only when no
   *  credentials are configured — since a misconfigured sender or an
   *  unverified "from" address fails delivery the same way an absent key
   *  does, and the developer testing this still needs the code. Never
   *  logged in production — the same secret-in-logs discipline everywhere
   *  else in this file. */
  private async sendResetCodeEmail(email: string, code: string): Promise<void> {
    const env = loadEnv();
    if (env.NODE_ENV !== 'production') {
      this.logger.log(`[dev] Password reset code for ${email}: ${code}`);
    }

    const mailer = this.mailer();
    if (!mailer) return;

    await mailer.sendMail({
      from: env.BREVO_FROM_EMAIL,
      to: email,
      subject: 'Your password reset code',
      text: `Your password reset code is ${code}. It expires in 15 minutes.`,
    });
  }

  private mailer(): Transporter | null {
    if (this.transporter !== undefined) return this.transporter;

    const env = loadEnv();
    this.transporter =
      env.BREVO_API_KEY && env.BREVO_SMTP_LOGIN && env.BREVO_FROM_EMAIL
        ? nodemailer.createTransport({
            host: BREVO_SMTP_HOST,
            port: BREVO_SMTP_PORT,
            auth: { user: env.BREVO_SMTP_LOGIN, pass: env.BREVO_API_KEY },
          })
        : null;
    return this.transporter;
  }
}
