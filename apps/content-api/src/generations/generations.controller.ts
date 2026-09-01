import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  creativeEditRequestSchema,
  creativeRequestSchema,
  type CreativeRequest,
} from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GenerationsService } from './generations.service.js';

/** Placeholder ceiling — there's no real cost-tolerance number yet, this
 *  exists so "unlimited" isn't the default. Tune once real usage exists. */
const generationRateLimitGuard = new PerUserRateLimitGuard(20, 3_600_000);

/**
 * The idempotency key becomes a BullMQ job id and a unique DB key, so it is
 * bounded and restricted to a safe alphabet. BullMQ rejects ':' in job ids
 * (see @bmas/shared queues.ts); an unvalidated key containing one would pass
 * this controller, insert a job row, then throw at enqueue time — leaving an
 * orphaned row and a 500. Excluding it here turns that into a clean 400.
 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;

/** Bounds the page size: NaN or a negative reaches Postgres as an invalid
 *  LIMIT and 500s, and an unbounded value invites a full-table scan. */
function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? 20);
  if (!Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

@UseGuards(JwtAuthGuard)
@Controller('generations')
export class GenerationsController {
  constructor(private readonly generations: GenerationsService) {}

  @UseGuards(generationRateLimitGuard)
  @Post()
  create(
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(creativeRequestSchema)) body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key header is required and must be 8–128 characters of [A-Za-z0-9._-]',
      );
    }
    return this.generations.enqueue(body as CreativeRequest, idempotencyKey, req.user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.generations.findOne(id, req.user.id);
  }

  /** Stops a queued or running generation. POST rather than DELETE: the row is
   *  kept and marked `cancelled` so it still shows in history. */
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.generations.cancel(id, req.user.id);
  }

  @Get()
  list(
    @Query('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    // Without a brand the query becomes `WHERE brand_id = undefined`, which
    // Drizzle rejects at runtime — surface it as a 400 instead of a 500.
    if (!brandId) throw new BadRequestException('brandId query parameter is required');
    return this.generations.listByBrand(brandId, req.user.id, parseLimit(limit));
  }

  /** FR-3.3: "Regenerate" on one image. Queued, not synchronous — the client
   *  polls `GET :id` the same way it already polls the job itself, watching
   *  for this asset's edit to leave 'queued'/'running' in the response's
   *  `assetEdits`. */
  @Post(':id/assets/:assetId/regenerate')
  regenerateAsset(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(creativeEditRequestSchema)) body: unknown,
  ) {
    const { instruction } = body as { assetId: string; instruction: string };
    return this.generations.regenerateAsset(id, assetId, req.user.id, instruction);
  }
}
