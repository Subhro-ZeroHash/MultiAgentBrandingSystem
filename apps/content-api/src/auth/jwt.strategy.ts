import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { eq, schema, type Database } from '@bmas/db';
import type { AuthUser } from '@bmas/shared';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DATABASE } from '../core/core.module.js';
import { loadEnv } from '../config/env.js';

interface JwtPayload {
  sub: string;
}

/**
 * Verifies the token's signature (handled by passport-jwt before `validate`
 * runs) and re-reads the user from the database on every request, rather than
 * trusting the payload's claims — a user deleted after their token was issued
 * must not keep working until expiry.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(DATABASE) private readonly db: Database) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: loadEnv().AUTH_SECRET,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const [user] = await this.db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, payload.sub))
      .limit(1);
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return user;
  }
}
