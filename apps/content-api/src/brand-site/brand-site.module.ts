import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module.js';
import { BrandSiteController } from './brand-site.controller.js';
import { BrandSiteService } from './brand-site.service.js';

@Module({
  // For BrandContextService: applying an import is the one moment we learn
  // something about the brand without asking the user, so the Brand Brain is
  // filled from it there rather than waiting for someone to open the screen.
  imports: [BrandsModule],
  controllers: [BrandSiteController],
  providers: [BrandSiteService],
})
export class BrandSiteModule {}
