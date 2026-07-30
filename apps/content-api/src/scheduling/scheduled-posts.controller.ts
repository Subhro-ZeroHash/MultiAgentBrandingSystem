import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  approveScheduledPostSchema,
  scheduledPostStatusSchema,
  updateScheduledPostSchema,
  type ApproveScheduledPostInput,
  type UpdateScheduledPostInput,
} from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { getUserIdFromHeader } from '../common/user-id.js';
import { SchedulingService } from './scheduling.service.js';

@Controller('scheduled-posts')
export class ScheduledPostsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get()
  list(
    @Query('brandId') brandId: string,
    @Headers('x-user-id') userId: string | undefined,
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

    return this.scheduling.listPosts(brandId, getUserIdFromHeader(userId), parsed?.data);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.getPost(id, getUserIdFromHeader(userId));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string | undefined,
    @Body(new ZodValidationPipe(updateScheduledPostSchema)) body: unknown,
  ) {
    return this.scheduling.updatePost(
      id,
      getUserIdFromHeader(userId),
      body as UpdateScheduledPostInput,
    );
  }

  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string | undefined,
    @Body(new ZodValidationPipe(approveScheduledPostSchema)) body: unknown,
  ) {
    return this.scheduling.approvePost(
      id,
      getUserIdFromHeader(userId),
      body as ApproveScheduledPostInput,
    );
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.rejectPost(id, getUserIdFromHeader(userId));
  }

  @Post(':id/regenerate')
  regenerate(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    return this.scheduling.regeneratePost(id, getUserIdFromHeader(userId));
  }
}
