import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  createScheduledCampaignSchema,
  updateScheduledCampaignSchema,
  type CreateScheduledCampaignInput,
  type UpdateScheduledCampaignInput,
} from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SchedulingService } from './scheduling.service.js';

/** Same clamp-and-default convention as GenerationsController's `parseLimit`
 *  — a brand's campaigns accumulate for its whole lifetime with no cap. */
function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? 50);
  if (!Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(1, Math.floor(value)));
}

@UseGuards(JwtAuthGuard)
@Controller()
export class ScheduledCampaignsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post('brands/:brandId/scheduled-campaigns')
  create(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createScheduledCampaignSchema)) body: unknown,
  ) {
    return this.scheduling.createCampaign(
      brandId,
      req.user.id,
      body as CreateScheduledCampaignInput,
    );
  }

  @Get('scheduled-campaigns')
  list(
    @Query('brandId') brandId: string,
    @Query('limit') limit: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.scheduling.listCampaigns(brandId, req.user.id, parseLimit(limit));
  }

  @Get('scheduled-campaigns/:id')
  findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.getCampaign(id, req.user.id);
  }

  @Patch('scheduled-campaigns/:id')
  update(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateScheduledCampaignSchema)) body: unknown,
  ) {
    return this.scheduling.updateCampaign(id, req.user.id, body as UpdateScheduledCampaignInput);
  }

  @Post('scheduled-campaigns/:id/pause')
  pause(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.pauseCampaign(id, req.user.id);
  }

  @Post('scheduled-campaigns/:id/resume')
  resume(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.resumeCampaign(id, req.user.id);
  }

  @Delete('scheduled-campaigns/:id')
  cancel(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.cancelCampaign(id, req.user.id);
  }
}
