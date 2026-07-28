import { loadEnv } from '../config/env.js';

/** Until auth lands, every write needs *some* owner id. A caller-supplied
 *  header wins when present (lets a future auth layer opt in per request);
 *  otherwise every write falls back to the same dev user so foreign keys
 *  resolve against the row `pnpm db:seed` creates. */
export function getUserIdFromHeader(userId: string | undefined): string {
  if (userId) return userId;
  return loadEnv().DEV_OWNER_ID;
}
