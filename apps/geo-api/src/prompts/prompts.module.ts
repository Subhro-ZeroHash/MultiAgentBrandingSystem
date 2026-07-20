import { Module } from '@nestjs/common';
import { PromptsController } from './prompts.controller.js';
import { PromptsService } from './prompts.service.js';

@Module({
  controllers: [PromptsController],
  providers: [PromptsService],
  exports: [PromptsService],
})
export class PromptsModule {}
