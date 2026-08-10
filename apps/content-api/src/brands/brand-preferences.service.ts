import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, schema, type Database } from '@bmas/db';
import type { BrandPreference, PreferenceType, RecordPreferenceInput } from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';

/** Every preference type, in the order the Brand Brain screen lists them. */
const PREFERENCE_TYPES: PreferenceType[] = [
  'content_format',
  'posting_time',
  'visual_style',
  'tone',
  'topic',
];

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
    if (brand.ownerId !== ownerId) {
      throw new ForbiddenException('This brand belongs to another account.');
    }
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
   * The current belief: the newest observation per type.
   *
   * `minConfidence` defaults above zero because a low-confidence learning is
   * worse than none in a prompt — the model treats it as fact regardless of the
   * number attached, so filtering is the only thing that actually works.
   */
  async getTopPreferences(
    brandId: string,
    type?: PreferenceType,
    minConfidence = 0.4,
  ): Promise<BrandPreference[]> {
    const types = type ? [type] : PREFERENCE_TYPES;

    const rows = await Promise.all(
      types.map(async (preferenceType) => {
        const [row] = await this.db
          .select()
          .from(schema.brandPreferences)
          .where(
            and(
              eq(schema.brandPreferences.brandId, brandId),
              eq(schema.brandPreferences.preferenceType, preferenceType),
            ),
          )
          .orderBy(desc(schema.brandPreferences.createdAt))
          .limit(1);
        return row;
      }),
    );

    return rows
      .filter((row): row is NonNullable<typeof row> => row != null)
      .filter((row) => row.confidence >= minConfidence) as BrandPreference[];
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
