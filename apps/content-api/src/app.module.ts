import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AssetsModule } from './assets/assets.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BrandSiteModule } from './brand-site/brand-site.module.js';
import { BrandsModule } from './brands/brands.module.js';
import { CoreModule } from './core/core.module.js';
import { GenerationsModule } from './generations/generations.module.js';
import { VideoGenerationsModule } from './video-generations/video-generations.module.js';
import { PlanningModule } from './planning/planning.module.js';
import { HealthModule } from './health/health.module.js';
import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { SocialModule } from './social/social.module.js';
import { TrendsModule } from './trends/trends.module.js';

/**
 * One module per pipeline concern, mirroring the creative flow:
 *   brands        -> the Brand Kit and its products
 *   brand-site    -> reads the brand's own website into the Brand Kit (FR-1.4)
 *   trends        -> Trend Research Agent: search + score ideas ahead of generation
 *   intelligence  -> Leads/Business-Intelligence Agent + the AI research prompt box
 *   generations   -> intake, job status, variant selection and edits
 *   scheduling    -> plan a campaign once, generate + gate every post on approval
 *   social        -> Instagram/Facebook OAuth & posting
 *   notifications -> push token registration (sending happens in content-worker)
 *   assets        -> public signed reads, for consumers that fetch images themselves
 *   (worker)      -> trends -> brief -> image -> QA -> copy -> (scheduled posts only) notify -> publish
 */
/**
 * Global request ceiling, per client IP.
 *
 * A flood stop, not a per-user ration, and sized that way on purpose: phone
 * clients share an egress address whenever they sit behind the same NAT — an
 * office, a campus, a room of testers being onboarded together — so whatever
 * number goes here is divided by however many people are on that wifi, not
 * spent by one of them. A limit tuned to what a single client "should" need
 * would read a busy room as an attack.
 *
 * The budgets that actually have to be tight are keyed on something better
 * than an IP: credential attempts are per account (see
 * CredentialThrottlerGuard), and provider spend is bounded in the worker
 * rather than at the edge.
 */
const GLOBAL_RATE_LIMIT = { ttl: 60_000, limit: 1_000 };

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [GLOBAL_RATE_LIMIT],
      // The default is the exception's class name ("ThrottlerException: Too
      // Many Requests"), which the app renders verbatim into the signup and
      // login error banners. Clients surface `message` as-is, so this is the
      // one place a rate-limited user's wording can be set.
      errorMessage: 'Too many attempts. Wait a minute and try again.',
    }),
    CoreModule,
    HealthModule,
    AuthModule,
    BrandsModule,
    BrandSiteModule,
    TrendsModule,
    IntelligenceModule,
    GenerationsModule,
    VideoGenerationsModule,
    PlanningModule,
    SchedulingModule,
    SocialModule,
    NotificationsModule,
    AssetsModule,
  ],
  // Global rather than per-controller: a route added later is rate limited by
  // default instead of by remembering to opt in. Opt *out* is explicit
  // (`@SkipThrottle()` on health, which monitoring polls on a fixed interval).
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
