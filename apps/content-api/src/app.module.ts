import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { BrandsModule } from './brands/brands.module.js';
import { CoreModule } from './core/core.module.js';
import { GenerationsModule } from './generations/generations.module.js';
import { HealthModule } from './health/health.module.js';
import { SocialModule } from './social/social.module.js';

/**
 * One module per pipeline concern, mirroring the creative flow:
 *   brands      -> the Brand Kit and its products
 *   generations -> intake, job status, variant selection and edits
 *   social      -> Instagram/Facebook OAuth & posting
 *   assets      -> public signed reads, for consumers that fetch images themselves
 *   (worker)    -> brief -> image -> QA -> copy
 */
@Module({
  imports: [CoreModule, HealthModule, BrandsModule, GenerationsModule, SocialModule, AssetsModule],
})
export class AppModule {}
