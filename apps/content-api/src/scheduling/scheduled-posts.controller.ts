import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import {
  approveScheduledPostSchema,
  scheduledPostStatusSchema,
  updateScheduledPostSchema,
  type ApproveScheduledPostInput,
  type UpdateScheduledPostInput,
} from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SchedulingService } from './scheduling.service.js';

@UseGuards(JwtAuthGuard)
@Controller('scheduled-posts')
export class ScheduledPostsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get()
  list(
    @Query('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('status') status?: string,
  ) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');

    // Parsed, not cast. An unrecognised label used to reach Postgres as an enum
    // comparison and come back to the client as a 500 rather than a 400.
    const parsed = status === undefined ? undefined : scheduledPostStatusSchema.safeParse(status);
    if (parsed && !parsed.success) {
      throw new BadRequestException(
        `Unknown status '${status}'. Expected one of: ${scheduledPostStatusSchema.options.join(', ')}`,
      );
    }

    return this.scheduling.listPosts(brandId, req.user.id, parsed?.data);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.getPost(id, req.user.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateScheduledPostSchema)) body: unknown,
  ) {
    return this.scheduling.updatePost(
      id,
      req.user.id,
      body as UpdateScheduledPostInput,
    );
  }

  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(approveScheduledPostSchema)) body: unknown,
  ) {
    return this.scheduling.approvePost(
      id,
      req.user.id,
      body as ApproveScheduledPostInput,
    );
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.rejectPost(id, req.user.id);
  }

  @Post(':id/regenerate')
  regenerate(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.scheduling.regeneratePost(id, req.user.id);
  }
}
