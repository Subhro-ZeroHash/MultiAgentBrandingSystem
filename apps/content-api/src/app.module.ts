import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { BrandSiteModule } from './brand-site/brand-site.module.js';
import { BrandsModule } from './brands/brands.module.js';
import { CoreModule } from './core/core.module.js';
import { GenerationsModule } from './generations/generations.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { SocialModule } from './social/social.module.js';
import { TrendsModule } from './trends/trends.module.js';

/**
 * One module per pipeline concern, mirroring the creative flow:
 *   brands        -> the Brand Kit and its products
 *   brand-site    -> reads the brand's own website into the Brand Kit (FR-1.4)
 *   trends        -> Trend Research Agent: search + score ideas ahead of generation
 *   generations   -> intake, job status, variant selection and edits
 *   scheduling    -> plan a campaign once, generate + gate every post on approval
 *   social        -> Instagram/Facebook OAuth & posting
 *   notifications -> push token registration (sending happens in content-worker)
 *   assets        -> public signed reads, for consumers that fetch images themselves
 *   (worker)      -> trends -> brief -> image -> QA -> copy -> (scheduled posts only) notify -> publish
 */
@Module({
  imports: [
    CoreModule,
    HealthModule,
    BrandsModule,
    BrandSiteModule,
    TrendsModule,
    GenerationsModule,
    SchedulingModule,
    SocialModule,
    NotificationsModule,
    AssetsModule,
  ],
})
export class AppModule {}
