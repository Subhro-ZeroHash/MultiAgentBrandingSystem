import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
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
