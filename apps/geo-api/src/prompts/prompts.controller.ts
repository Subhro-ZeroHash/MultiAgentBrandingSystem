import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { createTrackedPromptSchema } from '@bmas/shared';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PromptsService } from './prompts.service.js';

@UseGuards(JwtAuthGuard)
@Controller('prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get()
  list(@Query('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.prompts.listByBrand(brandId, req.user.id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createTrackedPromptSchema)) body: unknown,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prompts.create(body as Parameters<PromptsService['create']>[0], req.user.id);
  }

  /** Replaces the AI-suggested prompt set; user-added prompts are untouched. */
  @Post('refresh')
  refresh(@Query('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.prompts.refreshSuggested(brandId, req.user.id);
  }

  /** Takes a prompt off the list. Keeps its probe history if it has any —
   *  see `PromptsService.remove`. */
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.prompts.remove(id, req.user.id);
  }

  /** Manual trigger; the scheduled sweep uses the same path from the worker. */
  @Post(':id/probe')
  probe(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.prompts.enqueueProbe(id, req.user.id);
  }
}
