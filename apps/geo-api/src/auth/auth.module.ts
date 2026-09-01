import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy.js';

/**
 * Verify-only: geo-api never issues tokens, only validates ones content-api
 * signed (both read the same AUTH_SECRET). No AuthController/JwtModule here —
 * signing lives solely in content-api so there is exactly one place a token
 * can originate from.
 */
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
})
export class AuthModule {}
