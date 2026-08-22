import { eq, schema, type Database } from '@bmas/db';

/**
 * Expo push delivery, shared by every pipeline that has news for the user.
 *
 * Lifted out of scheduled-post-hooks.ts once research runs started notifying
 * too: three pipelines sending through one helper keeps the fire-and-forget
 * contract below in one place, rather than each copy deciding for itself
 * whether a failed push should fail the job that triggered it.
 */

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Fire-and-forget by design: a push failing to send must never fail the job
 * that triggered it, and there is no receipt-tracking UI to feed a retry into.
 * The endpoint accepts a batch, so one call covers all of an owner's devices.
 */
export async function sendExpoPush(
  tokens: string[],
  message: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  if (tokens.length === 0) return;

  try {
    await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          sound: 'default',
          ...(message.data ? { data: message.data } : {}),
        })),
      ),
    });
  } catch (error) {
    console.error('[push] failed to send notification:', error);
  }
}

export async function pushTokensForOwner(db: Database, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ token: schema.pushTokens.expoPushToken })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.ownerId, ownerId));
  return rows.map((row) => row.token);
}

/**
 * Looks up an owner and notifies them in one step.
 *
 * Wrapped in its own try/catch rather than left to the caller: these calls sit
 * immediately after a committed transaction, and a push failure there must not
 * unwind work that already succeeded. Callers that already hold the ownerId
 * should use `sendExpoPush` with `pushTokensForOwner` directly.
 */
export async function notifyBrandOwner(
  db: Database,
  brandId: string,
  message: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    const [brand] = await db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) return;

    await sendExpoPush(await pushTokensForOwner(db, brand.ownerId), message);
  } catch (error) {
    console.error(`[push] could not notify owner of brand ${brandId}:`, error);
  }
}
