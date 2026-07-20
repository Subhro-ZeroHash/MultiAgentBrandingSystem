import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './health/health.module.js';
import { PromptsModule } from './prompts/prompts.module.js';
import { VisibilityModule } from './visibility/visibility.module.js';

/**
 * One module per pipeline concern, mirroring the GEO stages:
 *   prompts   -> what we ask
 *   (worker)  -> probing engines + analysing answers
 *   visibility-> scores read by the dashboard and the digest
 */
@Module({
  imports: [CoreModule, HealthModule, PromptsModule, VisibilityModule],
})
export class AppModule {}
