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
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { NotificationsService } from './notifications.service.js';

const registerPushTokenSchema = z.object({ token: z.string().min(1) });

@UseGuards(JwtAuthGuard)
@Controller('push-tokens')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  register(
    @Body(new ZodValidationPipe(registerPushTokenSchema)) body: { token: string },
    @Request() req: AuthenticatedRequest,
  ) {
    return this.notifications.registerPushToken(req.user.id, body.token);
  }
}

/** Separate controller/prefix from the token-registration one above — a
 *  history list is a different resource, not another push-tokens verb. */
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationHistoryController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Query('brandId') brandId: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!brandId) throw new BadRequestException('brandId query param is required');
    const limit = limitStr ? parseInt(limitStr, 10) : 30;
    if (Number.isNaN(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be a number between 1 and 100');
    }
    return this.notifications.listForBrand(brandId, req.user.id, limit);
  }

  /** Dismiss/ignore is the same action as delete: history has no read state
   *  to flip, so the only way to make a row go away is to remove it. */
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.notifications.deleteOne(id, req.user.id);
  }
}
