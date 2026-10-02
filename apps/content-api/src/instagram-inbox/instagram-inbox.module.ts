import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module.js';
import { InstagramWebhookController } from './instagram-webhook.controller.js';

@Module({
  imports: [CoreModule],
  controllers: [InstagramWebhookController],
})
export class InstagramInboxModule {}
