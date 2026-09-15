import { BadRequestException, Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import type { GoogleReview } from '@bmas/db';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { GoogleReviewsService } from './google-reviews.service.js';

const REVIEW_STATUSES = [
  'needs_reply',
  'draft_ready',
  'approved',
  'published',
  'dismissed',
] as const satisfies readonly GoogleReview['status'][];

/** Same clamp-and-default convention as GenerationsController's `parseLimit`
 *  — unlimited reviews accumulate for the lifetime of the brand's Google
 *  listing, so a default cap keeps this endpoint bounded regardless of that. */
function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? 50);
  if (!Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(1, Math.floor(value)));
}

/** Read-only: replies are fully automatic (see GoogleReviewsService), so
 *  there is nothing here for a person to draft, edit, or approve. */
@UseGuards(JwtAuthGuard)
@Controller('google/reviews')
export class GoogleReviewsController {
  constructor(private readonly reviews: GoogleReviewsService) {}

  @Get()
  list(
    @Query('brandId') brandId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    if (!brandId) throw new BadRequestException('brandId query param is required');
    if (status && !REVIEW_STATUSES.includes(status as GoogleReview['status'])) {
      throw new BadRequestException(`status must be one of: ${REVIEW_STATUSES.join(', ')}`);
    }
    return this.reviews.listForBrand(
      brandId,
      req.user.id,
      status as GoogleReview['status'] | undefined,
      parseLimit(limit),
    );
  }
}
