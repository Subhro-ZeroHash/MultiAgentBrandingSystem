import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller.js';
import { CoreModule } from '../core/core.module.js';

@Module({
  imports: [CoreModule],
  controllers: [AssetsController],
})
export class AssetsModule {}
