import { Module } from '@nestjs/common';
import { TrendsController } from './trends.controller.js';
import { TrendsService } from './trends.service.js';

@Module({
  controllers: [TrendsController],
  providers: [TrendsService],
})
export class TrendsModule {}
