import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { askBrandResearchSchema, type AskBrandResearchInput } from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AiResearchService } from './ai-research.service.js';

@UseGuards(JwtAuthGuard)
@Controller('brands/:brandId/ai-research')
export class AiResearchController {
  constructor(private readonly aiResearch: AiResearchService) {}

  /** "Ask about your brand..." Answers inline — no queue, no polling, see
   *  AiResearchService's header for why. */
  @Post()
  ask(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(askBrandResearchSchema)) body: AskBrandResearchInput,
  ) {
    return this.aiResearch.ask(brandId, req.user.id, body.question);
  }

  @Get()
  history(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.aiResearch.listHistory(
      brandId,
      req.user.id,
      limit === undefined ? undefined : Number(limit),
    );
  }
}
