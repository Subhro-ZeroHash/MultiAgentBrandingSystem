import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './health/health.module.js';
import { PromptsModule } from './prompts/prompts.module.js';
import { VisibilityModule } from './visibility/visibility.module.js';

/**
 * One module per pipeline concern, mirroring the GEO stages:
 *   auth      -> verifies tokens content-api issued (see auth/auth.module.ts)
 *   prompts   -> what we ask
 *   (worker)  -> probing engines + analysing answers
 *   visibility-> scores read by the dashboard and the digest
 */
/** Global request ceiling, per client IP — a flood stop, not a per-user
 *  ration. Mirrors content-api/src/app.module.ts's GLOBAL_RATE_LIMIT; this
 *  app had none at all until now, leaving every route (including probe,
 *  which fans out paid AI-engine calls) fully open. */
const GLOBAL_RATE_LIMIT = { ttl: 60_000, limit: 1_000 };

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [GLOBAL_RATE_LIMIT],
      errorMessage: 'Too many attempts. Wait a minute and try again.',
    }),
    AuthModule,
    CoreModule,
    HealthModule,
    PromptsModule,
    VisibilityModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
