import { Module } from '@nestjs/common';
import { GenerationsModule } from '../generations/generations.module.js';
import { PlanningController } from './planning.controller.js';
import { PlanningService } from './planning.service.js';

/**
 * Imports GenerationsModule rather than re-implementing the enqueue: approving
 * a plan item must go through exactly the same validated, idempotent, cost-
 * recorded path a user-initiated generation does. A second way to start a
 * generation would be a second place for the guardrails to be forgotten.
 */
@Module({
  imports: [GenerationsModule],
  controllers: [PlanningController],
  providers: [PlanningService],
  exports: [PlanningService],
})
export class PlanningModule {}
