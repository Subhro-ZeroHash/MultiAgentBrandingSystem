import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import {
  requestTrendResearchSchema,
  scheduleTrendOpportunitySchema,
  updateTrendOpportunityStatusSchema,
  type RequestTrendResearchInput,
  type ScheduleTrendOpportunityInput,
  type UpdateTrendOpportunityStatusInput,
} from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TrendsService } from './trends.service.js';

@UseGuards(JwtAuthGuard)
@Controller('brands/:brandId/trend-research')
export class TrendsController {
  constructor(private readonly trends: TrendsService) {}

  /** "Find Trending Content Ideas." Returns immediately with the queued run;
   *  the client polls GET :runId the same way it already polls generations. */
  @Post()
  start(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(requestTrendResearchSchema)) body: unknown,
  ) {
    return this.trends.startResearch(
      brandId,
      req.user.id,
      body as RequestTrendResearchInput,
    );
  }

  @Get()
  list(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.trends.listRuns(
      brandId,
      req.user.id,
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get(':runId')
  getOne(
    @Param('runId') runId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.trends.getRun(runId, req.user.id);
  }

  /** The raw evidence a run's opportunities were clustered from — see
   *  TrendsService.getSignals. Not shown by default in the main feed; a
   *  transparency/debugging surface for "why did the platform think this
   *  mattered". */
  @Get(':runId/signals')
  getSignals(
    @Param('runId') runId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.trends.getSignals(runId, req.user.id);
  }

  /** Work On This / Save / Ignore on one opportunity — see
   *  TrendsService.updateOpportunityStatus for why this also writes to Brand
   *  Memory, not just this row. */
  @Patch(':runId/opportunities/:opportunityId')
  updateOpportunityStatus(
    @Param('opportunityId') opportunityId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateTrendOpportunityStatusSchema))
    body: UpdateTrendOpportunityStatusInput,
  ) {
    return this.trends.updateOpportunityStatus(opportunityId, req.user.id, body);
  }

  /** "Schedule for Approval" — the alternative to /create for a high-
   *  opportunity signal cluster; see TrendsService.scheduleOpportunity. */
  @Post(':runId/opportunities/:opportunityId/schedule')
  scheduleOpportunity(
    @Param('opportunityId') opportunityId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(scheduleTrendOpportunitySchema))
    body: ScheduleTrendOpportunityInput,
  ) {
    return this.trends.scheduleOpportunity(opportunityId, req.user.id, body);
  }
}
