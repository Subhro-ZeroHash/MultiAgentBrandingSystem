import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';

@Injectable()
export class VisibilityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Latest snapshot per brand — what the dashboard headline reads. */
  async latest(brandId: string) {
    const [snapshot] = await this.db
      .select()
      .from(schema.visibilitySnapshots)
      .where(eq(schema.visibilitySnapshots.brandId, brandId))
      .orderBy(desc(schema.visibilitySnapshots.periodStart))
      .limit(1);

    return snapshot ?? null;
  }

  /** Score history for the trend chart. */
  async history(brandId: string, since: Date) {
    return this.db
      .select()
      .from(schema.visibilitySnapshots)
      .where(
        and(
          eq(schema.visibilitySnapshots.brandId, brandId),
          gte(schema.visibilitySnapshots.periodStart, since),
        ),
      )
      .orderBy(schema.visibilitySnapshots.periodStart);
  }

  /** Recent raw answers, for the "why did we score that" drill-down. */
  async recentRuns(brandId: string, limit = 20) {
    return this.db
      .select()
      .from(schema.probeRuns)
      .where(eq(schema.probeRuns.brandId, brandId))
      .orderBy(desc(schema.probeRuns.runAt))
      .limit(limit);
  }
}
