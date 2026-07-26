import { Module } from '@nestjs/common';
import { SocialService } from './social.service.js';
import { SocialController } from './social.controller.js';
import { CoreModule } from '../core/core.module.js';

@Module({
  imports: [CoreModule],
  providers: [SocialService],
  controllers: [SocialController],
  exports: [SocialService],
})
export class SocialModule {}
