import { Controller, Get, Param, Query } from '@nestjs/common';
import { VisibilityService } from './visibility.service.js';

@Controller('brands/:brandId/visibility')
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get()
  latest(@Param('brandId') brandId: string) {
    return this.visibility.latest(brandId);
  }

  @Get('history')
  history(@Param('brandId') brandId: string, @Query('days') days = '90') {
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
    return this.visibility.history(brandId, since);
  }

  @Get('runs')
  runs(@Param('brandId') brandId: string, @Query('limit') limit = '20') {
    return this.visibility.recentRuns(brandId, Number(limit));
  }
}
