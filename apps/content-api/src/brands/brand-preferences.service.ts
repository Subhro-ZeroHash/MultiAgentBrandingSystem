import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, schema, type Database } from '@bmas/db';
import type { BrandPreference, PreferenceType, RecordPreferenceInput } from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';

/**
 * Learned preferences (1.7).
 *
 * Append-only, without exception: `recordPreference` inserts, and nothing in
 * this service updates or deletes. A learning is an observation made at a
 * moment from a sample, so overwriting the old one throws away the thing that
 * makes it trustworthy — "reels win" is a weak claim; "reels win, said three
 * times over two months with rising confidence" is not.
 *
 * The cost is that reads have to pick a winner, which `getTopPreferences` does:
 * newest per type, because a later observation saw more data than an earlier
 * one. Confidence filters rather than ranks — a stale finding at 0.9 should not
 * outrank this week's at 0.7.
 */
@Injectable()
export class BrandPreferencesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
  }

  /**
   * Appends a learning.
   *
   * No dedupe and no upsert on purpose — see the class comment. Callers are the
   * performance analyzer (Phase 5) and the user confirming a preference by hand.
   */
  async recordPreference(brandId: string, input: RecordPreferenceInput): Promise<BrandPreference> {
    const [row] = await this.db
      .insert(schema.brandPreferences)
      .values({
        brandId,
        preferenceType: input.preferenceType,
        preference: input.preference,
        confidence: input.confidence,
        learnedFrom: input.learnedFrom ?? null,
      })
      .returning();

    if (!row) throw new Error('Insert returned no row');
    return row as BrandPreference;
  }

  /**
   * The current belief: the newest observation per type, dropped (not
   * replaced by an older one) if it's below `minConfidence`.
   *
   * `minConfidence` defaults above zero because a low-confidence learning is
   * worse than none in a prompt — the model treats it as fact regardless of the
   * number attached, so filtering is the only thing that actually works.
   *
   * Kept in sync with `@bmas/db`'s `loadLearnings` — same question ("what
   * does this brand currently believe?") for a different caller. Change the
   * "newest row, then filter by confidence" order here only alongside that
   * one, or the two will quietly disagree on the same brand's current belief
   * again, the way they did before this comment existed.
   */
  async getTopPreferences(
    brandId: string,
    type?: PreferenceType,
    minConfidence = 0.4,
  ): Promise<BrandPreference[]> {
    const brandFilter = eq(schema.brandPreferences.brandId, brandId);

    // A single type is already a one-row query. Asking for all of them (the
    // common case — every caller but `historyForOwner`'s sibling) used to fan
    // out into one query per type; `DISTINCT ON` gets the same "newest row
    // per type" result in one round trip instead of `PREFERENCE_TYPES.length`.
    const rows = type
      ? await this.db
          .select()
          .from(schema.brandPreferences)
          .where(and(brandFilter, eq(schema.brandPreferences.preferenceType, type)))
          .orderBy(desc(schema.brandPreferences.createdAt))
          .limit(1)
      : await this.db
          .selectDistinctOn([schema.brandPreferences.preferenceType])
          .from(schema.brandPreferences)
          .where(brandFilter)
          .orderBy(schema.brandPreferences.preferenceType, desc(schema.brandPreferences.createdAt));

    return (rows as BrandPreference[]).filter((row) => row.confidence >= minConfidence);
  }

  /**
   * How one belief has moved, oldest first.
   *
   * The reason the table is append-only, made visible: a confidence curve that
   * climbs is a finding worth acting on, one that oscillates is noise, and
   * neither is legible from a single current row.
   */
  async getPreferenceTrend(
    brandId: string,
    type: PreferenceType,
    limit = 50,
  ): Promise<BrandPreference[]> {
    const rows = await this.db
      .select()
      .from(schema.brandPreferences)
      .where(
        and(
          eq(schema.brandPreferences.brandId, brandId),
          eq(schema.brandPreferences.preferenceType, type),
        ),
      )
      .orderBy(asc(schema.brandPreferences.createdAt))
      .limit(limit);
    return rows as BrandPreference[];
  }

  /** Ownership-checked wrapper for the HTTP surface. */
  async historyForOwner(
    brandId: string,
    ownerId: string,
    type: PreferenceType,
  ): Promise<BrandPreference[]> {
    await this.assertBrandOwned(brandId, ownerId);
    return this.getPreferenceTrend(brandId, type);
  }

  /** Ownership-checked wrapper for the HTTP surface. */
  async listForOwner(
    brandId: string,
    ownerId: string,
    type?: PreferenceType,
  ): Promise<BrandPreference[]> {
    await this.assertBrandOwned(brandId, ownerId);
    return this.getTopPreferences(brandId, type);
  }

  /**
   * The current beliefs as prompt-ready lines.
   *
   * Agents get these rather than the rows: a model handed `{confidence: 0.62,
   * deltaPercent: 34, ...}` spends attention parsing a data structure, and the
   * `summary` field exists precisely so it does not have to.
   */
  async getPromptLines(brandId: string): Promise<string[]> {
    const preferences = await this.getTopPreferences(brandId);
    return preferences.map((preference) => preference.preference.summary);
  }
}
