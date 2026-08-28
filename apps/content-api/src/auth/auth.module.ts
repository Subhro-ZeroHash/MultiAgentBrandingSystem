import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { loadEnv } from '../config/env.js';
import { BrandsModule } from '../brands/brands.module.js';
import { TrendsModule } from '../trends/trends.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AutopilotActivityService } from './autopilot-activity.service.js';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [
    PassportModule,
    // For AutopilotActivityService, which login/me use to resume any brand
    // the inactivity sweep paused while this user was away.
    BrandsModule,
    TrendsModule,
    IntelligenceModule,
    JwtModule.registerAsync({
      useFactory: (): JwtModuleOptions => {
        const env = loadEnv();
        // AUTH_TOKEN_TTL is validated as a non-empty string in env.ts;
        // @nestjs/jwt's `expiresIn` type is `ms`'s `StringValue` union rather
        // than plain `string`, which zod has no equivalent for — narrowed
        // here rather than loosening the env schema's type for everyone.
        const signOptions: JwtModuleOptions['signOptions'] = {
          expiresIn: env.AUTH_TOKEN_TTL as NonNullable<
            JwtModuleOptions['signOptions']
          >['expiresIn'],
        };
        return { secret: env.AUTH_SECRET, signOptions };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AutopilotActivityService, JwtStrategy],
  // JwtAuthGuard is exported implicitly by being importable directly (it has
  // no injected dependencies of its own); other modules import the guard
  // class, not this module.
  exports: [AuthService],
})
export class AuthModule {}
