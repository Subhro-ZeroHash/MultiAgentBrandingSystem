import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { createDirectiveSchema } from '@bmas/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlanningService } from './planning.service.js';

const requestPlanSchema = z.object({
  focus: z.string().max(300).nullable().optional(),
  horizonDays: z.number().int().min(1).max(90).optional(),
});

@UseGuards(JwtAuthGuard)
@Controller()
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  /** The current plan with its items, or null before the brand's first one. */
  @Get('brands/:brandId/plan')
  getPlan(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.planning.getActivePlan(brandId, req.user.id);
  }

  /** What this brand used to be doing — superseded plans, newest first. */
  @Get('brands/:brandId/plan/history')
  history(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.planning.listPlanHistory(brandId, req.user.id);
  }

  /** Draft a new plan. Returns once queued; the planner runs in the worker. */
  @Post('brands/:brandId/plan/refresh')
  refresh(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(requestPlanSchema)) body: z.infer<typeof requestPlanSchema>,
  ) {
    return this.planning.requestPlan(brandId, req.user.id, {
      focus: body.focus ?? null,
      ...(body.horizonDays === undefined ? {} : { horizonDays: body.horizonDays }),
    });
  }

  /** The steering conversation, oldest first — the panel renders this as-is. */
  @Get('brands/:brandId/plan/directives')
  directives(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.planning.listDirectives(brandId, req.user.id);
  }

  /**
   * Send one steering message.
   *
   * This is the whole steering interface: "focus on the 100m dash in Delhi
   * instead" goes in here, and the agents work out the rest.
   */
  @Post('brands/:brandId/plan/directives')
  sendDirective(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createDirectiveSchema)) body: { text: string },
  ) {
    return this.planning.sendDirective(brandId, req.user.id, body.text);
  }

  /** Everything waiting on the user, ranked. The app's home surface. */
  @Get('brands/:brandId/inbox')
  inbox(@Param('brandId') brandId: string, @Request() req: AuthenticatedRequest) {
    return this.planning.getInbox(brandId, req.user.id);
  }

  /** Approve one item. This is the only call in the module that spends money. */
  @Post('plan-items/:id/approve')
  approve(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.planning.approveItem(id, req.user.id);
  }

  /** Dismiss this idea and ask for a different one in its place. */
  @Post('plan-items/:id/replace')
  replace(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.planning.replaceItem(id, req.user.id);
  }

  @Post('plan-items/:id/reject')
  reject(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.planning.rejectItem(id, req.user.id);
  }
}
