import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module.js';
import { InboxSettingsController } from './inbox-settings.controller.js';
import { InstagramWebhookController } from './instagram-webhook.controller.js';

@Module({
  imports: [CoreModule],
  controllers: [InstagramWebhookController, InboxSettingsController],
})
export class InstagramInboxModule {}
