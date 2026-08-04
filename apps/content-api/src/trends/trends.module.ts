import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { TrendsController } from './trends.controller.js';
import { TrendsService } from './trends.service.js';

@Module({
  // For "Schedule for Approval" — see TrendsService.scheduleOpportunity.
  imports: [SchedulingModule],
  controllers: [TrendsController],
  providers: [TrendsService],
})
export class TrendsModule {}
