import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { approveScheduledPostSchema, type ApproveScheduledPostInput } from '@bmas/shared';
import type { ScheduledPost } from '@bmas/db';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SchedulingService } from './scheduling.service.js';

@Controller('scheduled-posts')
export class ScheduledPostsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get()
  list(@Query('brandId') brandId: string, @Query('status') status?: string) {
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.scheduling.listPosts(brandId, status as ScheduledPost['status'] | undefined);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.scheduling.getPost(id);
  }

  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveScheduledPostSchema)) body: unknown,
  ) {
    return this.scheduling.approvePost(id, body as ApproveScheduledPostInput);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string) {
    return this.scheduling.rejectPost(id);
  }

  @Post(':id/regenerate')
  regenerate(@Param('id') id: string) {
    return this.scheduling.regeneratePost(id);
  }
}
