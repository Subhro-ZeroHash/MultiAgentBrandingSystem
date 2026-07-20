import { Module } from '@nestjs/common';
import { BrandsModule } from './brands/brands.module.js';
import { CoreModule } from './core/core.module.js';
import { GenerationsModule } from './generations/generations.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * One module per pipeline concern, mirroring the creative flow:
 *   brands      -> the Brand Kit and its products
 *   generations -> intake, job status, variant selection and edits
 *   (worker)    -> brief -> image -> QA -> copy
 */
@Module({
  imports: [CoreModule, HealthModule, BrandsModule, GenerationsModule],
})
export class AppModule {}
