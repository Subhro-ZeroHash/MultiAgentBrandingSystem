import { Body, Controller, Headers, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { getUserIdFromHeader } from '../common/user-id.js';
import { NotificationsService } from './notifications.service.js';

const registerPushTokenSchema = z.object({ token: z.string().min(1) });

@Controller('push-tokens')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  register(
    @Body(new ZodValidationPipe(registerPushTokenSchema)) body: { token: string },
    @Headers('x-user-id') userId?: string,
  ) {
    return this.notifications.registerPushToken(getUserIdFromHeader(userId), body.token);
  }
}
