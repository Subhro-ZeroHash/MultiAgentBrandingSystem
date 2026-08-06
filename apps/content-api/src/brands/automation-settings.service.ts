import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, lte, schema, type Database } from '@bmas/db';
import {
  nextResearchAt,
  type AutomationSettings,
  type UpdateAutomationSettingsInput,
} from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';

/**
 * Automation configuration (1.8).
 *
 * Everything that decides whether the platform is allowed to act without being
 * asked. One row per brand, defaulting to fully manual — automation is opted
 * into, never inherited from a default that happened to be on.
 *
 * The scheduler (Phase 2) reads this table and nothing else to decide what work
 * exists, which is why `nextResearchAt` is a stored column rather than a
 * computation: "who is due" has to be an indexed range scan over brands, not a
 * per-row evaluation of a cadence.
 */
@Injectable()
export class AutomationSettingsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) {
      throw new ForbiddenException('This brand belongs to another account.');
    }
  }

  /**
   * Guarantees the brand has a settings row.
   *
   * Same reasoning as `BrandContextService.ensureContext`: brands predating
   * this feature have no row, and a nullable settings object would push the
   * defaults into every caller — where they would eventually disagree, and one
   * of those disagreements is "may this post to Instagram unattended".
   */
  async ensureSettings(brandId: string): Promise<AutomationSettings> {
    const existing = await this.read(brandId);
    if (existing) return existing;

    const [brand] = await this.db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);

    await this.db
      .insert(schema.automationSettings)
      .values({ brandId })
      .onConflictDoNothing({ target: schema.automationSettings.brandId });

    const created = await this.read(brandId);
    if (!created) throw new Error(`Failed to create automation settings for ${brandId}`);
    return created;
  }

  private async read(brandId: string): Promise<AutomationSettings | null> {
    const [row] = await this.db
      .select()
      .from(schema.automationSettings)
      .where(eq(schema.automationSettings.brandId, brandId))
      .limit(1);
    return (row as AutomationSettings | undefined) ?? null;
  }

  async getSettings(brandId: string, ownerId: string): Promise<AutomationSettings> {
    await this.assertBrandOwned(brandId, ownerId);
    return this.ensureSettings(brandId);
  }

  /**
   * Applies a settings change and keeps `nextResearchAt` honest.
   *
   * Two things are recomputed rather than trusted from the client:
   *   - the schedule, whenever the cadence changes or automation is switched
   *     on. Switching on with a stale `nextResearchAt` from a previous session
   *     is how a brand ends up enabled and never picked up.
   *   - nothing at all when automation is switched off — the column is left as
   *     it is, so re-enabling resumes the old cadence instead of resetting it.
   */
  async updateSettings(
    brandId: string,
    ownerId: string,
    input: UpdateAutomationSettingsInput,
  ): Promise<AutomationSettings> {
    await this.assertBrandOwned(brandId, ownerId);
    const current = await this.ensureSettings(brandId);

    const frequency = input.trendFrequency ?? current.trendFrequency;
    const enabled = input.contentAutomationEnabled ?? current.contentAutomationEnabled;
    const policy = input.approvalPolicy ?? current.approvalPolicy;
    const autoPublish = input.autoPublishEnabled ?? current.autoPublishEnabled;
    const autoTriggerOpportunities =
      input.autoTriggerHighScoreOpportunities ?? current.autoTriggerHighScoreOpportunities;

    // Publishing is the one step in the loop with no undo — a bad creative on a
    // live account cannot be recalled, only deleted after the fact. Refusing the
    // combination outright is clearer than silently ignoring the flag, which
    // would leave the settings screen claiming a capability that is off.
    if (autoPublish && policy !== 'full_autopilot') {
      throw new BadRequestException(
        'Auto-publishing requires the Full Autopilot approval policy. Change the policy first, or leave auto-publish off.',
      );
    }

    const scheduleChanged =
      (input.trendFrequency !== undefined && input.trendFrequency !== current.trendFrequency) ||
      (enabled && !current.contentAutomationEnabled);

    const [updated] = await this.db
      .update(schema.automationSettings)
      .set({
        trendFrequency: frequency,
        contentAutomationEnabled: enabled,
        autoPublishEnabled: autoPublish,
        approvalPolicy: policy,
        autoTriggerHighScoreOpportunities: autoTriggerOpportunities,
        ...(scheduleChanged
          ? { nextResearchAt: nextResearchAt(frequency, current.lastResearchAt) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.automationSettings.brandId, brandId))
      .returning();

    if (!updated) throw new Error('Update returned no row');
    return updated as AutomationSettings;
  }

  /** When this brand should next be researched, given what it has stored. */
  async calculateNextResearchAt(brandId: string): Promise<Date> {
    const settings = await this.ensureSettings(brandId);
    return nextResearchAt(settings.trendFrequency, settings.lastResearchAt);
  }

  /**
   * Stamps a completed research run and books the next one.
   *
   * Called by the worker after a run finishes, not when it is enqueued: marking
   * it up front means a run that crashes pushes the brand a full cadence into
   * the future, and nobody notices for a week.
   */
  async markResearchExecuted(brandId: string, at: Date = new Date()): Promise<AutomationSettings> {
    const settings = await this.ensureSettings(brandId);

    const [updated] = await this.db
      .update(schema.automationSettings)
      .set({
        lastResearchAt: at,
        nextResearchAt: nextResearchAt(settings.trendFrequency, at, at),
        updatedAt: new Date(),
      })
      .where(eq(schema.automationSettings.brandId, brandId))
      .returning();

    if (!updated) throw new Error('Update returned no row');
    return updated as AutomationSettings;
  }

  /**
   * Brands the scheduler should enqueue work for right now.
   *
   * The whole query is the `automation_settings_due_idx` index: enabled, and
   * due. A brand switched on but never researched has `nextResearchAt` set to
   * the moment it was enabled, so it comes back on the scheduler's next tick
   * rather than a cadence later.
   */
  async getBrandsDueForResearch(now: Date = new Date()): Promise<Array<{ brandId: string }>> {
    return this.db
      .select({ brandId: schema.automationSettings.brandId })
      .from(schema.automationSettings)
      .where(
        and(
          eq(schema.automationSettings.contentAutomationEnabled, true),
          lte(schema.automationSettings.nextResearchAt, now),
        ),
      );
  }
}
