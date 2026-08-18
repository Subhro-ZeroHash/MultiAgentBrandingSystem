import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
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

@UseGuards(JwtAuthGuard)
@Controller('brands/:brandId/visibility')
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  @Get()
  latest(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.visibility.latest(brandId, req.user.id);
  }

  @Get('history')
  history(
    @Param('brandId') brandId: string,
    @Query('days') days: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    const since = new Date(Date.now() - parseDays(days, 90) * 24 * 60 * 60 * 1000);
    return this.visibility.history(brandId, since, req.user.id);
  }

  @Get('runs')
  runs(
    @Param('brandId') brandId: string,
    @Query('limit') limit: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.visibility.recentRuns(brandId, parseLimit(limit, 20), req.user.id);
  }

  @Get('runs/:runId/mentions')
  mentions(
    @Param('brandId') brandId: string,
    @Param('runId') runId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.visibility.mentionsForRun(brandId, runId, req.user.id);
  }

  @Get('mentions')
  recentMentions(
    @Param('brandId') brandId: string,
    @Query('limit') limit: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.visibility.recentMentions(brandId, parseLimit(limit, 20), req.user.id);
  }

  @Get('by-engine')
  byEngine(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.visibility.byEngine(brandId, req.user.id);
  }
}
