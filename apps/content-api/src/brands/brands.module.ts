import { Module } from '@nestjs/common';
import { BrandsController } from './brands.controller.js';
import { BrandsService } from './brands.service.js';

@Module({
  controllers: [BrandsController],
  providers: [BrandsService],
  exports: [BrandsService],
})
export class BrandsModule {}
