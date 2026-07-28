import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { createScheduledCampaignSchema, type CreateScheduledCampaignInput } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SchedulingService } from './scheduling.service.js';

@Controller()
export class ScheduledCampaignsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post('brands/:brandId/scheduled-campaigns')
  create(
    @Param('brandId') brandId: string,
    @Body(new ZodValidationPipe(createScheduledCampaignSchema)) body: unknown,
  ) {
    return this.scheduling.createCampaign(brandId, body as CreateScheduledCampaignInput);
  }

  @Get('scheduled-campaigns')
  list(@Query('brandId') brandId: string) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.scheduling.listCampaigns(brandId);
  }

  @Get('scheduled-campaigns/:id')
  findOne(@Param('id') id: string) {
    return this.scheduling.getCampaign(id);
  }

  @Delete('scheduled-campaigns/:id')
  cancel(@Param('id') id: string) {
    return this.scheduling.cancelCampaign(id);
  }
}
