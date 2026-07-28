import { Module } from '@nestjs/common';
import { GenerationsModule } from '../generations/generations.module.js';
import { ScheduledCampaignsController } from './scheduled-campaigns.controller.js';
import { ScheduledPostsController } from './scheduled-posts.controller.js';
import { SchedulingService } from './scheduling.service.js';

@Module({
  imports: [GenerationsModule],
  controllers: [ScheduledCampaignsController, ScheduledPostsController],
  providers: [SchedulingService],
})
export class SchedulingModule {}
