import { Controller, Body, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { askBrandResearchSchema, type AskBrandResearchInput } from '@bmas/shared';
import { getUserIdFromHeader } from '../common/user-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AiResearchService } from './ai-research.service.js';

@Controller('brands/:brandId/ai-research')
export class AiResearchController {
  constructor(private readonly aiResearch: AiResearchService) {}

  /** "Ask about your brand..." Answers inline — no queue, no polling, see
   *  AiResearchService's header for why. */
  @Post()
  ask(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(askBrandResearchSchema)) body: AskBrandResearchInput,
  ) {
    return this.aiResearch.ask(brandId, getUserIdFromHeader(userIdHeader), body.question);
  }

  @Get()
  history(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Query('limit') limit?: string,
  ) {
    return this.aiResearch.listHistory(
      brandId,
      getUserIdFromHeader(userIdHeader),
      limit === undefined ? undefined : Number(limit),
    );
  }
}
