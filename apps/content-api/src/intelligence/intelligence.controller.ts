import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  updateIntelligenceItemStatusSchema,
  type UpdateIntelligenceItemStatusInput,
} from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IntelligenceService } from './intelligence.service.js';

@UseGuards(JwtAuthGuard)
@Controller('brands/:brandId/intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  /** "Refresh My Intelligence Feed." Returns immediately with the queued run;
   *  the client polls GET /runs/:runId the same way it polls trend research. */
  @Post('runs')
  start(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.intelligence.startResearch(brandId, req.user.id);
  }

  @Get('runs')
  listRuns(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.intelligence.listRuns(
      brandId,
      req.user.id,
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get('runs/:runId')
  getRun(@Param('runId') runId: string, @Request() req: AuthenticatedRequest) {
    return this.intelligence.getRun(runId, req.user.id);
  }

  /** The feed itself — the most recent successful run's items, optionally
   *  narrowed to one category tab. What the UI's main screen reads. */
  @Get()
  getFeed(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('category') category?: string,
  ) {
    return this.intelligence.getFeed(brandId, req.user.id, category);
  }

  /** Whether the feed is stale enough to be worth a fresh run — see
   *  IntelligenceService.getStatus. What the client checks on screen focus
   *  instead of always kicking off a new run. */
  @Get('status')
  getStatus(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.intelligence.getStatus(brandId, req.user.id);
  }

  @Patch('items/:itemId')
  updateItemStatus(
    @Param('itemId') itemId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateIntelligenceItemStatusSchema))
    body: UpdateIntelligenceItemStatusInput,
  ) {
    return this.intelligence.updateItemStatus(itemId, req.user.id, body);
  }
}
