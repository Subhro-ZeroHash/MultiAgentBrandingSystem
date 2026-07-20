import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { createTrackedPromptSchema } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PromptsService } from './prompts.service.js';

@Controller('prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get()
  list(@Query('brandId') brandId: string) {
    return this.prompts.listByBrand(brandId);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createTrackedPromptSchema)) body: unknown) {
    return this.prompts.create(body as Parameters<PromptsService['create']>[0]);
  }

  /** Manual trigger; the scheduled sweep uses the same path from the worker. */
  @Post(':id/probe')
  probe(@Param('id') id: string) {
    return this.prompts.enqueueProbe(id);
  }
}
