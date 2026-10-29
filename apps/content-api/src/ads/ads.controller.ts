import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  triggerAdOptimizationSchema,
  type TriggerAdOptimizationInput,
} from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdsService } from './ads.service.js';

@UseGuards(JwtAuthGuard)
@Controller('ads')
export class AdsController {
  constructor(private readonly adsService: AdsService) {}

  /**
   * Returns active ad campaigns and performance metrics across platforms (Google, Meta, X).
   */
  @Get('campaigns')
  listCampaigns(
    @Request() req: AuthenticatedRequest,
    @Query('brandId') brandId?: string,
  ) {
    return this.adsService.listCampaigns(brandId, req.user.id);
  }

  /**
   * Returns AI optimization recommendations for the brand.
   */
  @Get('optimizations')
  listOptimizations(
    @Request() req: AuthenticatedRequest,
    @Query('brandId') brandId?: string,
    @Query('status') status?: string,
  ) {
    return this.adsService.listOptimizations(brandId, req.user.id, status);
  }

  /**
   * Applies an AI optimization recommendation.
   */
  @Post('optimizations/:id/apply')
  applyOptimization(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.adsService.applyOptimization(id, req.user.id);
  }

  /**
   * Dismisses an AI optimization recommendation.
   */
  @Post('optimizations/:id/dismiss')
  dismissOptimization(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.adsService.dismissOptimization(id, req.user.id);
  }

  /**
   * Manually triggers an ad optimization analysis job.
   */
  @Post('optimize')
  triggerOptimization(
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(triggerAdOptimizationSchema))
    body: unknown,
  ) {
    const input = body as TriggerAdOptimizationInput;
    return this.adsService.triggerOptimization(input.brandId, req.user.id);
  }
}
