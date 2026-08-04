import { Controller, Body, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { updateIntelligenceItemStatusSchema, type UpdateIntelligenceItemStatusInput } from '@bmas/shared';
import { getUserIdFromHeader } from '../common/user-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IntelligenceService } from './intelligence.service.js';

@Controller('brands/:brandId/intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  /** "Refresh My Intelligence Feed." Returns immediately with the queued run;
   *  the client polls GET /runs/:runId the same way it polls trend research. */
  @Post('runs')
  start(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    return this.intelligence.startResearch(brandId, getUserIdFromHeader(userIdHeader));
  }

  @Get('runs')
  listRuns(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Query('limit') limit?: string,
  ) {
    return this.intelligence.listRuns(
      brandId,
      getUserIdFromHeader(userIdHeader),
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get('runs/:runId')
  getRun(
    @Param('runId') runId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    return this.intelligence.getRun(runId, getUserIdFromHeader(userIdHeader));
  }

  /** The feed itself — the most recent successful run's items, optionally
   *  narrowed to one category tab. What the UI's main screen reads. */
  @Get()
  getFeed(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Query('category') category?: string,
  ) {
    return this.intelligence.getFeed(brandId, getUserIdFromHeader(userIdHeader), category);
  }

  @Patch('items/:itemId')
  updateItemStatus(
    @Param('itemId') itemId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(updateIntelligenceItemStatusSchema))
    body: UpdateIntelligenceItemStatusInput,
  ) {
    return this.intelligence.updateItemStatus(itemId, getUserIdFromHeader(userIdHeader), body);
  }
}
