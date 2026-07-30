import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createScheduledCampaignSchema,
  updateScheduledCampaignSchema,
  type CreateScheduledCampaignInput,
  type UpdateScheduledCampaignInput,
} from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { getUserIdFromHeader } from '../common/user-id.js';
import { SchedulingService } from './scheduling.service.js';

@Controller()
export class ScheduledCampaignsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post('brands/:brandId/scheduled-campaigns')
  create(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userId: string | undefined,
    @Body(new ZodValidationPipe(createScheduledCampaignSchema)) body: unknown,
  ) {
    return this.scheduling.createCampaign(
      brandId,
      getUserIdFromHeader(userId),
      body as CreateScheduledCampaignInput,
    );
  }

  @Get('scheduled-campaigns')
  list(@Query('brandId') brandId: string, @Headers('x-user-id') userId: string | undefined) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.scheduling.listCampaigns(brandId, getUserIdFromHeader(userId));
  }

  @Get('scheduled-campaigns/:id')
  findOne(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.getCampaign(id, getUserIdFromHeader(userId));
  }

  @Patch('scheduled-campaigns/:id')
  update(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string | undefined,
    @Body(new ZodValidationPipe(updateScheduledCampaignSchema)) body: unknown,
  ) {
    return this.scheduling.updateCampaign(
      id,
      getUserIdFromHeader(userId),
      body as UpdateScheduledCampaignInput,
    );
  }

  @Post('scheduled-campaigns/:id/pause')
  pause(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.pauseCampaign(id, getUserIdFromHeader(userId));
  }

  @Post('scheduled-campaigns/:id/resume')
  resume(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.resumeCampaign(id, getUserIdFromHeader(userId));
  }

  @Delete('scheduled-campaigns/:id')
  cancel(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.cancelCampaign(id, getUserIdFromHeader(userId));
  }
}
