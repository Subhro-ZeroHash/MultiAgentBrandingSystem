import { Controller, Body, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import {
  requestTrendResearchSchema,
  scheduleTrendOpportunitySchema,
  updateTrendOpportunityStatusSchema,
  type RequestTrendResearchInput,
  type ScheduleTrendOpportunityInput,
  type UpdateTrendOpportunityStatusInput,
} from '@bmas/shared';
import { getUserIdFromHeader } from '../common/user-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TrendsService } from './trends.service.js';

@Controller('brands/:brandId/trend-research')
export class TrendsController {
  constructor(private readonly trends: TrendsService) {}

  /** "Find Trending Content Ideas." Returns immediately with the queued run;
   *  the client polls GET :runId the same way it already polls generations. */
  @Post()
  start(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(requestTrendResearchSchema)) body: unknown,
  ) {
    return this.trends.startResearch(
      brandId,
      getUserIdFromHeader(userIdHeader),
      body as RequestTrendResearchInput,
    );
  }

  @Get()
  list(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Query('limit') limit?: string,
  ) {
    return this.trends.listRuns(
      brandId,
      getUserIdFromHeader(userIdHeader),
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get(':runId')
  getOne(
    @Param('runId') runId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    return this.trends.getRun(runId, getUserIdFromHeader(userIdHeader));
  }

  /** The raw evidence a run's opportunities were clustered from — see
   *  TrendsService.getSignals. Not shown by default in the main feed; a
   *  transparency/debugging surface for "why did the platform think this
   *  mattered". */
  @Get(':runId/signals')
  getSignals(
    @Param('runId') runId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    return this.trends.getSignals(runId, getUserIdFromHeader(userIdHeader));
  }

  /** Work On This / Save / Ignore on one opportunity — see
   *  TrendsService.updateOpportunityStatus for why this also writes to Brand
   *  Memory, not just this row. */
  @Patch(':runId/opportunities/:opportunityId')
  updateOpportunityStatus(
    @Param('opportunityId') opportunityId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(updateTrendOpportunityStatusSchema))
    body: UpdateTrendOpportunityStatusInput,
  ) {
    return this.trends.updateOpportunityStatus(opportunityId, getUserIdFromHeader(userIdHeader), body);
  }

  /** "Schedule for Approval" — the alternative to /create for a high-
   *  opportunity signal cluster; see TrendsService.scheduleOpportunity. */
  @Post(':runId/opportunities/:opportunityId/schedule')
  scheduleOpportunity(
    @Param('opportunityId') opportunityId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(scheduleTrendOpportunitySchema))
    body: ScheduleTrendOpportunityInput,
  ) {
    return this.trends.scheduleOpportunity(opportunityId, getUserIdFromHeader(userIdHeader), body);
  }
}
