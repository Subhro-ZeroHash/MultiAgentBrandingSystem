import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter keyed on the authenticated user's id, for routes
 * where the thing being rationed is cost per account (paid AI generation)
 * rather than flood protection.
 *
 * Deliberately not built on @nestjs/throttler: that module's ThrottlerGuard
 * only ever checks throttler *names* registered at module load time via
 * ThrottlerModule.forRoot — a name introduced purely through a route's
 * @Throttle() decorator is silently never evaluated by any guard instance.
 * Confirmed by reading its canActivate (`for (const namedThrottler of
 * this.throttlers)`, where `this.throttlers` comes only from the injected
 * module options) and by a live 22-request test against a running route
 * that never once 429'd. A second module-registered name doesn't fix it
 * either: every ThrottlerGuard instance active on a route — the global
 * default one included — walks every registered name, so a shared name
 * would have the global instance enforcing this same ceiling by IP, which
 * is exactly the shared-NAT problem GLOBAL_RATE_LIMIT's own comment warns
 * against. A small self-contained guard sidesteps both problems: it only
 * runs where it's explicitly attached, and only checks what it's told to.
 *
 * In-memory rather than Redis-backed, matching every other rate limit in
 * this app (@nestjs/throttler's own storage here is in-memory too) —
 * correct for the single-process deployment this runs as today. Resets on
 * restart, same as the framework's own throttler state does.
 *
 * Must be listed after an auth guard on the same route: relies on req.user
 * being populated already (Nest runs @UseGuards() entries in array order).
 */
@Injectable()
export class PerUserRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest & { ip?: string }>();
    const key = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const now = Date.now();

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (existing.count >= this.limit) {
      throw new HttpException(
        'Too many attempts. Wait a while and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    existing.count += 1;
    return true;
  }
}
