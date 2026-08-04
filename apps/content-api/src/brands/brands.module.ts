import { Module } from '@nestjs/common';
import { AutomationSettingsService } from './automation-settings.service.js';
import { BrandContextService } from './brand-context.service.js';
import { BrandPreferencesService } from './brand-preferences.service.js';
import { BrandsController } from './brands.controller.js';
import { BrandsService } from './brands.service.js';

@Module({
  controllers: [BrandsController],
  providers: [
    BrandsService,
    BrandContextService,
    BrandPreferencesService,
    AutomationSettingsService,
  ],
  // Exported because the Brand Brain is read from outside this module: the
  // website importer refreshes context after an apply, and the trend and
  // scheduling flows will read projections rather than reassembling them.
  exports: [
    BrandsService,
    BrandContextService,
    BrandPreferencesService,
    AutomationSettingsService,
  ],
})
export class BrandsModule {}
