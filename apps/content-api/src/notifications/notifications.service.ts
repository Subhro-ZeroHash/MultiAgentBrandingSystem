import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';

@Injectable()
export class NotificationsService {
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

  /** Newest-first history for the History screen — every push
   *  `notifyBrandOwner` has ever sent for this brand, regardless of whether
   *  it actually reached a device. */
  async listForBrand(brandId: string, ownerId: string, limit: number) {
    await this.assertBrandOwned(brandId, ownerId);

    return this.db
      .select()
      .from(schema.notificationHistory)
      .where(eq(schema.notificationHistory.brandId, brandId))
      .orderBy(desc(schema.notificationHistory.createdAt))
      .limit(limit);
  }

  /** Scoped to `ownerId` in the WHERE clause rather than checked after a
   *  lookup, so one owner can never delete another's row by guessing an id —
   *  a mismatch reads as "not found", not "forbidden". */
  async deleteOne(id: string, ownerId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(schema.notificationHistory)
      .where(and(eq(schema.notificationHistory.id, id), eq(schema.notificationHistory.ownerId, ownerId)))
      .returning({ id: schema.notificationHistory.id });
    if (!deleted) throw new NotFoundException(`Notification ${id} not found`);
  }

  /** Upserted on the token, not `(ownerId, token)` — a device only ever holds
   *  one live Expo push token, so a re-registration (reinstall, token
   *  refresh) should replace the old row rather than accumulate a new one.
   *  Sending itself happens in content-worker, which reads this table
   *  directly — the API's only job is to keep it up to date. */
  async registerPushToken(ownerId: string, token: string) {
    const [row] = await this.db
      .insert(schema.pushTokens)
      .values({ ownerId, expoPushToken: token })
      .onConflictDoUpdate({
        target: schema.pushTokens.expoPushToken,
        set: { ownerId, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }
}
