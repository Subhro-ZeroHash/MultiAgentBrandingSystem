import type { AuthUser } from '@bmas/shared';

/** Shape of `req` in any route behind `@UseGuards(JwtAuthGuard)` —
 *  `JwtStrategy.validate`'s return value, attached by Passport. */
export interface AuthenticatedRequest {
  user: AuthUser;
}
