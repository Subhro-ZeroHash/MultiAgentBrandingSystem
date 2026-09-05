import { Module } from '@nestjs/common';
import { NotificationHistoryController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController, NotificationHistoryController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
