import { Controller, Get, Param, Query } from '@nestjs/common';
import { VisibilityService } from './visibility.service.js';

/** Bounds the lookback window: a bare `Number()` turns a non-numeric or
 *  missing value into NaN, which reaches Postgres as an invalid Date and
 *  500s; an unbounded value invites scanning the whole table. */
function parseDays(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(365, value);
}

/** Same reasoning as `parseDays`, for a row-count LIMIT instead of a date. */
function parseLimit(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

@Controller('brands/:brandId/visibility')
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get()
  latest(@Param('brandId') brandId: string) {
    return this.visibility.latest(brandId);
  }

  @Get('history')
  history(@Param('brandId') brandId: string, @Query('days') days?: string) {
    const since = new Date(Date.now() - parseDays(days, 90) * 24 * 60 * 60 * 1000);
    return this.visibility.history(brandId, since);
  }

  @Get('runs')
  runs(@Param('brandId') brandId: string, @Query('limit') limit?: string) {
    return this.visibility.recentRuns(brandId, parseLimit(limit, 20));
  }
}
