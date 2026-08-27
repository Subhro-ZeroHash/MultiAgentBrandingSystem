import { Module } from '@nestjs/common';
import { VideoGenerationsController } from './video-generations.controller.js';
import { VideoGenerationsService } from './video-generations.service.js';

@Module({
  controllers: [VideoGenerationsController],
  providers: [VideoGenerationsService],
  exports: [VideoGenerationsService],
})
export class VideoGenerationsModule {}
