import { Module } from '@nestjs/common';
import { BrandSiteController } from './brand-site.controller.js';
import { BrandSiteService } from './brand-site.service.js';

@Module({
  controllers: [BrandSiteController],
  providers: [BrandSiteService],
})
export class BrandSiteModule {}
