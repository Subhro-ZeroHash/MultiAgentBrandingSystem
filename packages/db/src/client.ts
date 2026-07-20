import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  url: string;
  /** Workers hold long-lived pools; one-shot scripts should pass `max: 1`. */
  max?: number;
  ssl?: boolean;
}

export function createDatabase({ url, max = 10, ssl = false }: DatabaseOptions) {
  const client = postgres(url, {
    max,
    ssl: ssl ? 'require' : false,
    // Drizzle handles its own prepared-statement caching; disabling here keeps
    // us compatible with transaction-mode poolers (PgBouncer, Neon, Supabase).
    prepare: false,
  });

  return drizzle(client, { schema });
}

/** Closes the underlying pool. Call from a worker's shutdown hook. */
export async function closeDatabase(db: Database): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).$client?.end?.({ timeout: 5 });
}
