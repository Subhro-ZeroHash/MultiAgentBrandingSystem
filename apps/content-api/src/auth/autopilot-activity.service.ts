import { Inject, Injectable } from '@nestjs/common';
import { describeError } from '@bmas/ai';
import { and, eq, isNotNull, schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';
import { AutomationSettingsService } from '../brands/automation-settings.service.js';
import { TrendsService } from '../trends/trends.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';

/**
 * The other half of content-worker's inactivity sweep (see
 * research-scheduler.ts's sweepInactiveAutomation): that sweep pauses a
 * user's automation after 7 days with no login/refresh/`/auth/me` call; this
 * is what notices they're back and undoes it.
 *
 * Called from AuthController on `login` and `me` — the two routes that mean
 * "a person is looking at the app right now", as opposed to `refresh`, which
 * fires silently every ~15 minutes for as long as a session merely stays
 * open and says nothing about whether anyone is actually there.
 */
@Injectable()
export class AutopilotActivityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly automationSettings: AutomationSettingsService,
    private readonly trends: TrendsService,
    private readonly intelligence: IntelligenceService,
  ) {}

  /**
   * Stamps the user active, then resumes and immediately re-researches every
   * brand of theirs the inactivity sweep paused.
   *
   * Never throws: this runs inline in the login/me response path, and a
   * failure here (a queue blip, a brand deleted mid-flight) must not turn a
   * successful login into a 500. One brand's resume failing is logged and
   * skipped — same "one bad row doesn't sink the rest" rule the scheduler
   * itself follows.
   */
  async recordActivity(userId: string): Promise<void> {
    let paused: Array<{ brandId: string }>;
    try {
      await this.db
        .update(schema.users)
        .set({ lastActiveAt: new Date() })
        .where(eq(schema.users.id, userId));

      paused = await this.db
        .select({ brandId: schema.automationSettings.brandId })
        .from(schema.automationSettings)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.automationSettings.brandId))
        .where(
          and(eq(schema.brands.ownerId, userId), isNotNull(schema.automationSettings.autoPausedAt)),
        );
    } catch (error) {
      console.error(
        `[autopilot-activity] failed to record activity for ${userId}: ${describeError(error)}`,
      );
      return;
    }

    for (const { brandId } of paused) {
      try {
        // Reuses the exact "turning automation on" path a person clicking
        // the toggle themselves would take — same schedule recomputation,
        // same clearing of autoPausedAt (see updateSettings's turningOn
        // branch) — rather than a second, easily-drifting copy of that logic.
        await this.automationSettings.updateSettings(brandId, userId, {
          contentAutomationEnabled: true,
        });
        // "on the spot" means now, not whenever the 10-hourly scheduler tick
        // next comes around — the whole point is the client doesn't sit on a
        // week-old feed while waiting for a scheduled run. Both start*
        // calls only enqueue; the actual research happens in content-worker
        // same as any other run, so this stays fast.
        await this.trends.startResearch(brandId, userId, {});
        await this.intelligence.startResearch(brandId, userId);
      } catch (error) {
        console.error(
          `[autopilot-activity] resume failed for brand ${brandId}: ${describeError(error)}`,
        );
      }
    }
  }
}
