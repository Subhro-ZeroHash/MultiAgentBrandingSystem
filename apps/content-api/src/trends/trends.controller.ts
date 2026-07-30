import { Controller, Body, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { requestTrendResearchSchema, type RequestTrendResearchInput } from '@bmas/shared';
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
}
