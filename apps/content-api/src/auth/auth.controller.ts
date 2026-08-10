import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { loginInputSchema, signupInputSchema, type AuthUser } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * Buckets credential attempts by the account being attempted, not the caller's
 * IP — overriding the global guard's tracker for these two routes only.
 *
 * The default IP tracker is wrong in both directions here:
 *
 *  - It punishes the innocent. Mobile clients behind one NAT — an office, a
 *    campus, a room of testers being onboarded together — share an egress
 *    address, so an IP budget sized for one person throttles all of them. A
 *    hundred people signing up on the same wifi is a normal minute for this
 *    product, and measured per IP it is indistinguishable from an attack.
 *
 *  - It fails to stop the guilty. Guessing one account's password from a
 *    spread of addresses is the ordinary shape of credential stuffing, and a
 *    per-IP counter never sees the same bucket twice.
 *
 * Falls back to the IP tracker when there is no email to key on: such a
 * request is malformed and gets rejected downstream, but bucketing all of them
 * under one constant would let a single sender exhaust everyone's budget.
 */
const trackByAccount = (req: Record<string, unknown>): string => {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
  if (email) return `credential:${email}`;
  return `ip:${(req.ip as string | undefined) ?? 'unknown'}`;
};

/**
 * Credential attempts allowed per account per minute.
 *
 * Far below the global ceiling because these are the two routes where an
 * unlimited caller gets something worth having: password guesses on `login`,
 * and free account creation on `signup`. Bcrypt's cost factor already makes
 * each guess expensive to *serve*; this is what makes a run of them
 * impractical to *make* — before, 60 wrong passwords went through in three
 * seconds with nothing to slow them down.
 *
 * Ten is generous for a human mistyping their own password and useless to
 * someone working through a wordlist.
 */
const AUTH_RATE_LIMIT = {
  default: { ttl: 60_000, limit: 10, getTracker: trackByAccount },
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle(AUTH_RATE_LIMIT)
  @Post('signup')
  signup(@Body(new ZodValidationPipe(signupInputSchema)) body: unknown) {
    return this.auth.signup(body as Parameters<AuthService['signup']>[0]);
  }

  @Throttle(AUTH_RATE_LIMIT)
  @Post('login')
  login(@Body(new ZodValidationPipe(loginInputSchema)) body: unknown) {
    return this.auth.login(body as Parameters<AuthService['login']>[0]);
  }

  /** Stateless JWT: nothing to invalidate server-side. Exists so the client
   *  has a symmetric call to make and a place to hang server-side revocation
   *  later (e.g. a token blocklist) without changing the frontend contract. */
  @Post('logout')
  logout() {
    return { ok: true };
  }

  /** Lets the app verify a stored token on launch and recover the user it
   *  belongs to, without re-sending credentials. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: { user: AuthUser }) {
    return req.user;
  }
}
