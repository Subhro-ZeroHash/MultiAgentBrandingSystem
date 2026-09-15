import { Module } from '@nestjs/common';
import { GoogleAuthService } from './google-auth.service.js';
import { GoogleAuthController } from './google-auth.controller.js';
import { GoogleReviewsService } from './google-reviews.service.js';
import { GoogleReviewsController } from './google-reviews.controller.js';
import { CoreModule } from '../core/core.module.js';

@Module({
  imports: [CoreModule],
  providers: [GoogleAuthService, GoogleReviewsService],
  controllers: [GoogleAuthController, GoogleReviewsController],
  exports: [GoogleAuthService, GoogleReviewsService],
})
export class GoogleModule {}
