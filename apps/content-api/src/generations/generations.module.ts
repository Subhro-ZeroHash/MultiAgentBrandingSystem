import { Module } from '@nestjs/common';
import { GenerationsController } from './generations.controller.js';
import { GenerationsService } from './generations.service.js';

@Module({
  controllers: [GenerationsController],
  providers: [GenerationsService],
  exports: [GenerationsService],
})
export class GenerationsModule {}
