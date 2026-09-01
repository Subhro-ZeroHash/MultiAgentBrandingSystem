import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { videoGenerationRequestSchema, type VideoGenerationRequest } from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { VideoGenerationsService } from './video-generations.service.js';

/** Same key shape and reasoning as GenerationsController's — a BullMQ job id
 *  doubles as this, so the same restricted alphabet applies. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;

/** See GenerationsController's identical guard for why this is its own
 *  standalone limiter rather than an @nestjs/throttler override, and why the
 *  number is a placeholder. Video generation costs more per request than an
 *  image, but starts at the same ceiling until real usage data says
 *  otherwise. A separate instance from generations.controller.ts's — each
 *  route gets its own independent budget, not a shared one. */
const videoGenerationRateLimitGuard = new PerUserRateLimitGuard(20, 3_600_000);

@UseGuards(JwtAuthGuard)
@Controller('video-generations')
export class VideoGenerationsController {
  constructor(private readonly videoGenerations: VideoGenerationsService) {}

  @UseGuards(videoGenerationRateLimitGuard)
  @Post()
  create(
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(videoGenerationRequestSchema)) body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key header is required and must be 8–128 characters of [A-Za-z0-9._-]',
      );
    }
    return this.videoGenerations.enqueue(
      body as VideoGenerationRequest,
      idempotencyKey,
      req.user.id,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.videoGenerations.findOne(id, req.user.id);
  }
}
