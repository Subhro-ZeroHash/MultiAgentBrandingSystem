import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applies pending migrations. Used by `pnpm db:migrate` and by deploys.
 *
 * Deliberately the programmatic migrator rather than the `drizzle-kit migrate`
 * CLI: this runs from the built output with no dev dependencies, so the same
 * command works locally, in CI, and in a production release step.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
  process.exit(1);
}

// A migration runner must be the only writer; a single connection avoids
// two workers racing to take the migration lock.
const client = postgres(url, {
  max: 1,
  onnotice: () => {},
  ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
});

try {
  await migrate(drizzle(client), { migrationsFolder: resolve(here, '../migrations') });
  console.warn('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
