import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';

@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
