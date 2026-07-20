import { Module } from '@nestjs/common';
import { VisibilityController } from './visibility.controller.js';
import { VisibilityService } from './visibility.service.js';

@Module({
  controllers: [VisibilityController],
  providers: [VisibilityService],
  exports: [VisibilityService],
})
export class VisibilityModule {}
